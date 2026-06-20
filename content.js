(() => {

if (!globalThis.__douyinCommentCollector) {
  globalThis.__douyinCommentCollector = {
    running: false, paused: false, timer: null, observer: null,
    comments: [], seen: new Set(), cardToComment: new WeakMap(),
    expandedButtons: new WeakSet(), expandedTextButtons: new WeakSet(),
    options: { maxComments: 5000, delayMs: 2000, collectReplies: true, expandText: true, maxExpandPerTick: 999, expandWaitMs: 1600 },
    progress: { tick: 0, added: 0, updated: 0, expandedText: 0, expandedReplies: 0, stableLoops: 0, scrollTop: 0, scrollHeight: 0, visibleCandidates: 0, observerOn: false, phase: "" },
    state: { status: "ready", message: "Ready", count: 0, lastUpdatedAt: null, currentUrl: location.href, progress: {} },
    listenerRegistered: false
  };
}
const cc = globalThis.__douyinCommentCollector;

const COMMENT_TEXT_MIN = 2;
const MAX_NODE_SCAN = 2000;
const COMMENT_TAB_XPATH = '//*[@id="semiTabcomment"]/span';
const NO_MORE_COMMENT_RE = /暂时没有更多评论|没有更多评论|已显示全部评论|到底了|没有了/;

const NON_USER_NAMES = new Set([
  "搜索","详情","充钻石","客户端","我的","大家都在搜","收起","展开",
  "登录","注册","分享","收藏","点赞","评论","转发","相关推荐","推荐给朋友",
  "抖音","首页","朋友","消息","我"
]);

if (!cc.listenerRegistered) {
  cc.listenerRegistered = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    const run = async () => {
      if (msg.type === "collector:start")     return startComments(msg.options || {});
      if (msg.type === "collector:pause")     return pauseComments();
      if (msg.type === "collector:resume")    return resumeComments();
      if (msg.type === "collector:stop")      return stopComments("已停止");
      if (msg.type === "collector:clear")     return clearComments();
      if (msg.type === "collector:dedupe")    return dedupeCommentsLocal();
      if (msg.type === "collector:diagnose")  return diagnose();
      return { ok: true, state: cc.state };
    };
    run().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  });
}

/* ================================================================
 *  主流程：四阶段分离架构
 *  阶段1: 打开评论区
 *  阶段2: 懒加载全部评论
 *  阶段3: 展开所有折叠内容（回复 + 长文本）
 *  阶段4: 一次性采集
 *  阶段5: 验证补采
 * ================================================================ */

async function startComments(opts) {
  cc.options = {
    maxComments: cl(opts.maxComments, 1, 10000, 5000),
    delayMs: cl(opts.delayMs, 500, 15000, 2000),
    collectReplies: Boolean(opts.collectReplies !== false),
    expandText: Boolean(opts.expandText !== false),
    maxExpandPerTick: 999,
    expandWaitMs: cl(opts.expandWaitMs, 300, 7000, 1600)
  };
  const stored = await chrome.storage.local.get(["comments"]);
  cc.comments = dedupeArr(Array.isArray(stored.comments) ? stored.comments : []);
  cc.seen = new Set(cc.comments.map(commentKey));
  cc.cardToComment = new WeakMap();
  cc.expandedButtons = new WeakSet();
  cc.expandedTextButtons = new WeakSet();
  cc.progress = emptyProgress();
  cc.running = true; cc.paused = false;
  setCommentState("running", "开始采集...");
  await persistComments();

  ensureFloatingPanel();
  updateFloatingPanel();

  /* ---- 阶段1: 打开评论区 ---- */
  setProgress("阶段1/4: 打开评论区");
  const commentReady = await ensureCommentTabOpen(false);
  if (!commentReady) {
    cc.running = false;
    setCommentState("error", "没有打开评论区，请先点击页面右侧评论再开始");
    showCollectorToast("未进入评论区", "已停止采集");
    await persistCommentState();
    return snapshot();
  }
  await sleep(800);

  /* ---- 阶段2: 懒加载全部评论 ---- */
  setProgress("阶段2/4: 加载全部评论（懒加载）");
  await loadAllComments();

  /* ---- 阶段3: 展开所有折叠内容 ---- */
  if (cc.options.collectReplies || cc.options.expandText) {
    setProgress("阶段3/4: 展开所有折叠内容");
    await expandAllContent();
  }

  /* ---- 阶段4: 一次性采集 ---- */
  setProgress("阶段4/4: 采集全部评论");
  await collectAllComments();

  /* 完成 */
  await stopComments("采集完成");
  showCollectorToast("采集完成", "共 " + cc.comments.length + " 条评论");

  return snapshot();
}

/* ---- 阶段2: 懒加载全部评论 ---- */
async function loadAllComments() {
  const container = findCommentScrollContainer();
  if (!container) {
    console.log("[DouyinCollector] loadAllComments: 未找到评论容器");
    return;
  }
  console.log("[DouyinCollector] loadAllComments: 开始懒加载 (max=" + cc.options.maxComments + ")");
  setCommentState("running", "正在加载全部评论（滚动触发懒加载）...");

  let lastHeight = 0;
  let stableCount = 0;

  for (let round = 0; round < 60; round++) {
    if (!cc.running) return;
    container.scrollTop = container.scrollHeight;
    await sleep(1500);

    const currentHeight = container.scrollHeight;

    /* 提前停止：已加载的卡片数远超用户设置的采集量 */
    const cardCount = countCommentCards();
    if (cardCount >= cc.options.maxComments * 2) {
      console.log("[DouyinCollector] loadAllComments: 卡片数 " + cardCount + " 已超过 " + (cc.options.maxComments * 2) + " → 提前停止懒加载");
      break;
    }

    if (currentHeight === lastHeight) {
      stableCount++;
      console.log("[DouyinCollector] loadAllComments round " + round + ": 高度不变 " + currentHeight + " stable=" + stableCount);
      if (stableCount >= 3) {
        if (hasNoMoreCommentTip()) {
          console.log("[DouyinCollector] loadAllComments: 连续3轮无变化 + 没有更多提示 → 加载完成");
          break;
        }
        if (stableCount >= 5) {
          console.log("[DouyinCollector] loadAllComments: 连续5轮无变化 → 强制结束");
          break;
        }
      }
      await sleep(800);
    } else {
      stableCount = 0;
      console.log("[DouyinCollector] loadAllComments round " + round + ": 高度 " + lastHeight + " → " + currentHeight);
    }
    lastHeight = currentHeight;

    if (hasNoMoreCommentTip() && stableCount >= 1) {
      console.log("[DouyinCollector] loadAllComments: 检测到没有更多 + 稳定 → 完成");
      break;
    }
  }

  container.scrollTop = 0;
  await sleep(500);
  const count = countCommentCards();
  console.log("[DouyinCollector] loadAllComments 完成: 预计 " + count + " 条评论卡片");
  setCommentState("running", "评论加载完成，预计 " + count + " 条，开始展开...");
}

/* ---- 阶段3: 展开所有折叠内容（回复 + 长文本 合并为一次扫描） ---- */
async function expandAllContent() {
  const container = findCommentScrollContainer();
  if (!container) return;

  let totalReplyExpanded = 0;
  let totalTextExpanded = 0;
  let totalFailed = 0;

  /* 单次从顶到底扫描，遇到任何"展开类"按钮就点；
   * 一直滚到底+连续 N 轮没有新增点击就结束。
   * 不再分 sweep/3c 两段重复跑。 */
  if (!cc.options.collectReplies && !cc.options.expandText) {
    console.log("[DouyinCollector] expandAllContent: 用户关闭了所有展开选项");
    return;
  }

  console.log("[DouyinCollector] expandAllContent: 开始单次合并扫描（回复+长文本）");
  setCommentState("running", "展开折叠内容中（回复+长文本）...");
  container.scrollTop = 0;
  await sleep(400);

  let stableScrollCount = 0;
  let zeroNewClickRound = 0;

  for (let pass = 0; pass < 200; pass++) {
    if (!cc.running) return;

    /* 提前停止：已采集足够多 */
    if (cc.comments.length >= cc.options.maxComments * 1.2) {
      console.log("[DouyinCollector]   pass " + pass + ": 已采集 " + cc.comments.length + ", 接近上限 → 停止展开");
      break;
    }

    let passClickCount = 0;

    /* 1) 点回复展开按钮 */
    if (cc.options.collectReplies) {
      const replyBtns = findReplyExpandButtons().filter(b => !cc.expandedButtons.has(b));
      for (const b of replyBtns) {
        const success = await clickExpandButton(b);
        if (success) {
          cc.expandedButtons.add(b);
          totalReplyExpanded++;
          passClickCount++;
        } else {
          totalFailed++;
          /* 失败不加入 set，下次再试，但加一个失败计数避免死循环 */
          b.__expandFailCount = (b.__expandFailCount || 0) + 1;
          if (b.__expandFailCount >= 2) cc.expandedButtons.add(b);
        }
        if ((totalReplyExpanded + totalFailed) % 8 === 0) {
          setCommentState("running", "展开中... 回复 " + totalReplyExpanded + " 长文本 " + totalTextExpanded + " 失败 " + totalFailed);
        }
      }
    }

    /* 2) 点长文本展开按钮 */
    if (cc.options.expandText) {
      const textBtns = findTextExpandButtons().filter(b => !cc.expandedTextButtons.has(b));
      for (const b of textBtns) {
        safeScrollIntoCommentView(b);
        await sleep(120);
        safeClick(b);
        await sleep(Math.min(cc.options.expandWaitMs, 600));
        cc.expandedTextButtons.add(b);
        totalTextExpanded++;
        passClickCount++;
      }
    }

    /* 3) 滚一段：往下滚 60% 视口 */
    const oldTop = container.scrollTop;
    container.scrollTop += Math.floor(container.clientHeight * 0.6);
    await sleep(400);

    /* 4) 终止判定 */
    const scrolled = Math.abs(container.scrollTop - oldTop) >= 8;

    if (passClickCount === 0) {
      zeroNewClickRound++;
    } else {
      zeroNewClickRound = 0;
    }

    if (!scrolled) {
      stableScrollCount++;
      container.scrollTop = container.scrollHeight;
      await sleep(300);
    } else {
      stableScrollCount = 0;
    }

    /* 滚到底 + 连续 2 轮无点击 → 结束 */
    if (stableScrollCount >= 2 && zeroNewClickRound >= 2) {
      console.log("[DouyinCollector] expandAllContent: 已到底 + 连续无新增点击 → 结束");
      break;
    }
    /* 连续 4 轮无点击（还能滚）也结束 */
    if (zeroNewClickRound >= 4) {
      console.log("[DouyinCollector] expandAllContent: 连续 4 轮无可点击按钮 → 结束");
      break;
    }
  }

  container.scrollTop = 0;
  await sleep(300);
  console.log("[DouyinCollector] expandAllContent 完成: 回复 " + totalReplyExpanded + " 长文本 " + totalTextExpanded + " 失败 " + totalFailed);
  setCommentState("running", "展开完成（回复 " + totalReplyExpanded + " 文本 " + totalTextExpanded + "），开始采集...");
}

/* ---- 阶段4: 全量滚动采集
 * 经过阶段3全展开后，理论上数据都加载好了。但抖音是虚拟列表（offscreen 元素会被卸载），
 * 所以仍然走 scroll-then-extract，但用更大步进、更短延时，一气呵成跑完。
 * ---- */
async function collectAllComments() {
  console.log("[DouyinCollector] collectAllComments: 开始全量采集");
  setCommentState("running", "正在采集全部评论...");

  const container = findCommentScrollContainer();
  if (!container) {
    setCommentState("error", "未找到评论容器");
    return;
  }

  let totalAdded = 0;
  let totalUpdated = 0;
  let pass = 0;

  /* 通用提取函数 */
  const ingest = (extracted) => {
    let added = 0, updated = 0;
    for (const it of extracted) {
      const cardNode = it.__cardNode;
      delete it.__cardNode;
      if (cardNode && cc.cardToComment.has(cardNode)) {
        const idx = cc.cardToComment.get(cardNode);
        const existing = cc.comments[idx];
        if (existing && isBetterComment(it, existing)) {
          cc.seen.delete(commentKey(existing));
          cc.comments[idx] = it;
          cc.seen.add(commentKey(it));
          updated++;
        }
        continue;
      }
      const k = commentKey(it);
      if (!k || cc.seen.has(k)) continue;
      cc.seen.add(k);
      if (cardNode) cc.cardToComment.set(cardNode, cc.comments.length);
      cc.comments.push(it);
      added++;
      if (cc.comments.length >= cc.options.maxComments) break;
    }
    return { added, updated };
  };

  /* === 智能短路：先抓一次顶部 + 滚到底再抓一次。如果 DOM 没有虚拟化、数据全在，直接结束 === */
  container.scrollTop = 0;
  await sleep(300);
  const r1 = ingest(extractVisibleComments());
  totalAdded += r1.added; totalUpdated += r1.updated;
  console.log("[DouyinCollector]   shortcut 顶部抓取: 新增 " + r1.added + " (累计 " + cc.comments.length + ")");

  /* 直接滚到底 */
  container.scrollTop = container.scrollHeight;
  await sleep(600);
  const heightAfterBottom = container.scrollHeight;
  const r2 = ingest(extractVisibleComments());
  totalAdded += r2.added; totalUpdated += r2.updated;
  console.log("[DouyinCollector]   shortcut 底部抓取: 新增 " + r2.added + " (累计 " + cc.comments.length + ")");

  /* 短路条件：滚到底之后没新增 + 滚动高度没增加 → DOM 里就这么多，整体没虚拟化 */
  if (r2.added === 0 && r2.updated === 0) {
    /* 再抓一次顶部兜底（防止头部卡片在滚动后被卸载） */
    container.scrollTop = 0;
    await sleep(300);
    const r3 = ingest(extractVisibleComments());
    totalAdded += r3.added; totalUpdated += r3.updated;
    if (r3.added === 0) {
      cc.comments = dedupeArr(cc.comments);
      cc.seen = new Set(cc.comments.map(commentKey));
      cc.progress.added = totalAdded;
      console.log("[DouyinCollector] collectAllComments: 短路命中，DOM 数据已全, 跳过逐段滚动");
      setCommentState("running", "采集完成（DOM一次性全采）: 共 " + cc.comments.length + " 条");
      await persistComments();
      return;
    }
    /* 顶部又有新增 → 说明 DOM 是虚拟化的，回退到逐段滚动模式 */
    console.log("[DouyinCollector] collectAllComments: 顶部回滚有新增 " + r3.added + " 条 → 走逐段滚动");
  } else {
    console.log("[DouyinCollector] collectAllComments: 底部抓到新增 → DOM 是虚拟化的，走逐段滚动");
  }

  /* === 走原来的 scroll-then-extract 兜底逻辑 === */
  container.scrollTop = 0;
  await sleep(400);

  let stableCount = 0;
  const stepRatio = 0.9;
  const waitMs = 450;

  for (pass = 0; pass < 200; pass++) {
    if (!cc.running) return;

    /* 1. 先抓当前 DOM 中的全部评论 */
    const r = ingest(extractVisibleComments());
    totalAdded += r.added;
    totalUpdated += r.updated;
    if (pass % 5 === 0 || r.added > 0) {
      console.log("[DouyinCollector]   collect pass " + pass + ": 本轮新增 " + r.added + " 更新 " + r.updated + " (累计 " + cc.comments.length + ")");
    }
    if (r.added > 0 || r.updated > 0) {
      setCommentState("running", "采集中... 已采集 " + cc.comments.length + " 条 (pass " + (pass + 1) + ")");
      if (pass % 4 === 0) await persistComments();
    }

    /* 2. 滚一段 */
    const oldTop = container.scrollTop;
    const maxTop = container.scrollHeight - container.clientHeight;
    container.scrollTop = Math.min(maxTop, oldTop + Math.floor(container.clientHeight * stepRatio));
    await sleep(waitMs);

    /* 3. 终止判定 */
    if (Math.abs(container.scrollTop - oldTop) < 8) {
      stableCount++;
      if (stableCount >= 2) {
        const r2 = ingest(extractVisibleComments());
        totalAdded += r2.added;
        console.log("[DouyinCollector] collectAllComments: 已滚到底，连续 " + stableCount + " 轮无变化 → 结束");
        break;
      }
      container.scrollTop = container.scrollHeight;
      await sleep(500);
    } else {
      stableCount = 0;
    }

    if (cc.comments.length >= cc.options.maxComments) break;
  }

  cc.comments = dedupeArr(cc.comments);
  cc.seen = new Set(cc.comments.map(commentKey));
  cc.progress.added = totalAdded;
  console.log("[DouyinCollector] collectAllComments 完成: " + pass + " 轮, 新增 " + totalAdded + " 更新 " + totalUpdated + " 累计 " + cc.comments.length);
  setCommentState("running", "采集完成: " + (pass + 1) + " 轮, 新增 " + totalAdded + " 条，累计 " + cc.comments.length + " 条");
  await persistComments();
}

/* ---- 阶段5: 验证补采 ---- */
async function verifyAndFinalize() {
  console.log("[DouyinCollector] verifyAndFinalize: 验证补采");
  setCommentState("running", "验证采集中...");

  /* 多轮检查未展开按钮（可能在采集过程中新出现的） */
  for (let vRound = 0; vRound < 3; vRound++) {
    const remainingReply = findReplyExpandButtons().filter(b => !cc.expandedButtons.has(b));
    const remainingText = findTextExpandButtons().filter(b => !cc.expandedTextButtons.has(b));
    console.log("[DouyinCollector] verifyAndFinalize 第" + (vRound + 1) + "轮: 剩余回复按钮 " + remainingReply.length + " 文本按钮 " + remainingText.length);

    let hadAction = false;

    if (remainingReply.length > 0) {
      hadAction = true;
      for (const b of remainingReply) {
        const ok = await clickExpandButton(b);
        if (ok) cc.expandedButtons.add(b);
        await sleep(600);
      }
      await collectAllComments();
    }

    if (remainingText.length > 0) {
      hadAction = true;
      for (const b of remainingText) {
        safeClick(b);
        cc.expandedTextButtons.add(b);
        await sleep(cc.options.expandWaitMs);
      }
      await collectAllComments();
    }

    if (!hadAction) break;
    await sleep(500);
  }

  /* 滚回顶部 */
  const container = findCommentScrollContainer();
  if (container) container.scrollTop = 0;

  await stopComments("采集完成");
  showCollectorToast("采集完成", "共 " + cc.comments.length + " 条评论");
}

/* ================================================================
 *  生命周期函数（暂停/继续/停止/清空/去重）
 * ================================================================ */

async function pauseComments() {
  cc.paused = true;
  setCommentState("paused", "已暂停");
  await persistCommentState();
  return snapshot();
}

async function resumeComments() {
  if (!cc.running) cc.running = true;
  cc.paused = false;
  setCommentState("running", "继续采集");
  return snapshot();
}

async function stopComments(msg) {
  cc.running = false; cc.paused = false;
  cc.comments = dedupeArr(cc.comments);
  cc.seen = new Set(cc.comments.map(commentKey));
  setCommentState("stopped", msg);
  const container = findCommentScrollContainer();
  if (container) container.scrollTop = 0;
  await persistComments();
  return snapshot();
}

async function clearComments() {
  cc.running = false; cc.paused = false;
  cc.comments = []; cc.seen = new Set(); cc.cardToComment = new WeakMap(); cc.progress = emptyProgress();
  setCommentState("ready", "已清空本地评论数据");
  await chrome.storage.local.set({ comments: [], collectorState: cc.state });
  return snapshot();
}

async function dedupeCommentsLocal() {
  const before = cc.comments.length;
  cc.comments = dedupeArr(cc.comments);
  cc.seen = new Set(cc.comments.map(commentKey));
  cc.cardToComment = new WeakMap();
  setCommentState("ready", "去重完成，移除 " + (before - cc.comments.length) + " 条");
  await persistComments();
  return snapshot();
}

/* ================================================================
 *  诊断
 * ================================================================ */

async function diagnose() {
  const d = {
    pageType: detectPageType(),
    hasCommentArea: Boolean(findCommentScrollContainer()),
    commentCardCount: countCommentCards(),
    replyExpandButtons: findReplyExpandButtons().length,
    textExpandButtons: findTextExpandButtons().length,
    commentImageCount: countVisibleCommentImages(),
    title: document.title || "",
    url: location.href
  };
  return { ok: true, state: cc.state, diagnosis: d };
}

function detectPageType() {
  const url = location.href;
  if (/\/user\//.test(url)) return "用户主页";
  if (/\/video\//.test(url) || /modal_id=|aweme_id=/.test(url)) return "视频详情页";
  if (/\/note\//.test(url)) return "图文页";
  if (/\/search\//.test(url)) return "搜索页";
  return "抖音页面";
}

/* ================================================================
 *  展开回复按钮：TreeWalker + 四重点击策略
 * ================================================================ */

function isRendered(el) {
  if (!el || el.nodeType !== 1) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
  return true;
}

function findReplyExpandButtons() {
  const scope = findCommentScrollContainer() || document.body;
  let buttons = scanReplyExpandButtons(scope);
  if (buttons.length === 0) {
    console.log("[DouyinCollector] findReplyExpandButtons: 容器内未找到，扩大到 body");
    buttons = scanReplyExpandButtons(document.body);
  }
  console.log("[DouyinCollector] findReplyExpandButtons: " + buttons.length + " 个");
  if (buttons.length > 0 && buttons.length <= 30) {
    buttons.forEach((b, i) => {
      const r = b.getBoundingClientRect();
      console.log("[DouyinCollector]   按钮[" + i + "]: text='" + buttonText(b).slice(0, 40) + "' tag=" + b.tagName + " " + Math.round(r.width) + "x" + Math.round(r.height));
    });
  }
  return buttons;
}

function scanReplyExpandButtons(scope) {
  const results = [];
  const seen = new Set();

  /* 方法1：用户验证过的 XPath — //button//span[contains(text(),"展开")] */
  try {
    const xpathResult = document.evaluate(
      './/button//span[contains(text(),"展开")] | .//div[@role="button"]//span[contains(text(),"展开")] | .//span[@role="button" and contains(text(),"展开")]',
      scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    for (let i = 0; i < xpathResult.snapshotLength; i++) {
      const span = xpathResult.snapshotItem(i);
      const text = cleanText(span.textContent);
      if (!text || text.length > 40) continue;
      if (/收起|已展开|折叠/.test(text)) continue;
      if (/^回复$|^点赞$|^分享$/.test(text)) continue;
      const isReplyExpand = /展开.{0,10}回复/.test(text)
        || /查看.{0,10}回复/.test(text)
        || /^\d+\s*条?回复/.test(text)
        || /^展开(全部|所有)?\d*条?回复?$/.test(text)
        || /^更多回复$/.test(text)
        || text === "展开"
        || (/^展开.*/.test(text) && !/全文/.test(text));  /* 放宽：排除"展开全文" */
      if (!isReplyExpand) continue;
      const clickable = findClosestClickable(span);
      if (clickable && !seen.has(clickable) && isRendered(clickable)) {
        const r = clickable.getBoundingClientRect();
        if (r.width <= 500 && r.height <= 100) { seen.add(clickable); results.push(clickable); }
      }
    }
  } catch(e) {
    console.log("[DouyinCollector] scanReplyExpandButtons XPath异常: " + e.message);
  }

  /* 方法2：TreeWalker 兜底 */
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = cleanText(node.textContent);
      if (!text || text.length > 40) return NodeFilter.FILTER_REJECT;
      if (/收起|已展开|折叠/.test(text)) return NodeFilter.FILTER_REJECT;
      if (/^回复$|^点赞$|^分享$/.test(text)) return NodeFilter.FILTER_REJECT;
      if (/^展开(全部)?\d*条?(条)?回复?$/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/^展开(全部|所有)\d*条?回复?$/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/^展开\d+条回复$/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/^查看(全部|所有)?回复$/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/^更多回复$/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/^\d+条回复$/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/^展开(全部|所有)回复?$/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/展开.{0,10}回复/.test(text)) return NodeFilter.FILTER_ACCEPT;
      if (/查看.{0,10}回复/.test(text)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_REJECT;
    }
  });
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    let el = textNode.parentElement;
    if (!el) continue;
    const clickable = findClosestClickable(el);
    if (clickable && !seen.has(clickable)) {
      seen.add(clickable);
      if (isRendered(clickable)) {
        const r = clickable.getBoundingClientRect();
        if (r.width <= 500 && r.height <= 100) results.push(clickable);
      }
    }
  }
  return results;
}

function findClosestClickable(el) {
  let cur = el;
  for (let i = 0; cur && i < 6; i++) {
    if (cur.tagName === "BUTTON") return cur;
    if (cur.getAttribute && cur.getAttribute("role") === "button") return cur;
    try { if (getComputedStyle(cur).cursor === "pointer") return cur; } catch(e) {}
    cur = cur.parentElement;
  }
  return el;
}

async function clickExpandButton(el) {
  safeScrollIntoCommentView(el);
  await sleep(300);
  const beforeText = buttonText(el);
  const beforeLen = replyAreaTextLength(el);

  let success = await tryClickAt(el);
  if (success) return true;

  await sleep(200);
  success = await tryClickDirect(el, beforeText, beforeLen);
  if (success) return true;

  const parent = el.parentElement;
  if (parent && parent !== document.body) {
    await sleep(200);
    success = await tryClickDirect(parent, beforeText, beforeLen);
    if (success) return true;
  }

  const children = Array.from(el.querySelectorAll("span, div, p, a, svg, path, [role='button']"));
  for (const child of children.slice(0, 5)) {
    if (!isRendered(child)) continue;
    await sleep(150);
    success = await tryClickDirect(child, beforeText, beforeLen);
    if (success) return true;
  }
  return false;
}

async function tryClickAt(el) {
  try {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return false;
    const target = document.elementFromPoint(x, y);
    if (!target) return false;
    dispatchFullClick(target, x, y);
    await sleep(1000);
    return checkExpandSuccess(el);
  } catch(e) { return false; }
}

async function tryClickDirect(el, beforeText, beforeLen) {
  try {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    dispatchFullClick(el, x, y);
    await sleep(1000);
    return checkExpandSuccess(el, beforeText, beforeLen);
  } catch(e) { return false; }
}

function checkExpandSuccess(el, beforeText, beforeLen) {
  /* 按钮 DOM 已被移除（React 重渲染）→ 展开 succeeded */
  if (!el || !el.isConnected) return true;
  /* 按钮不再渲染（display:none / visibility:hidden）→ succeeded */
  if (!isRendered(el)) return true;
  const nowText = buttonText(el);
  if (/收起/.test(nowText) && !/收起/.test(beforeText || "")) return true;
  if (!/展开|查看|更多/.test(nowText) && /展开|查看|更多/.test(beforeText || "")) return true;
  if (beforeLen !== undefined) {
    const afterLen = replyAreaTextLength(el);
    if (afterLen > beforeLen + 5) return true;
  }
  return false;
}

function dispatchFullClick(el, x, y) {
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  const ptrOpts = { ...opts, pointerType: "mouse", pointerId: 1 };
  try {
    el.dispatchEvent(new PointerEvent("pointerover", ptrOpts));
    el.dispatchEvent(new PointerEvent("pointerenter", ptrOpts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new PointerEvent("pointerdown", ptrOpts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", ptrOpts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
  } catch(e) {
    try { if (typeof el.click === "function") el.click(); } catch(err) {}
  }
}

/* ================================================================
 *  展开长文本
 * ================================================================ */

function findTextExpandButtons() {
  const scope = findCommentScrollContainer() || document.body;
  return uniqueElements(Array.from(scope.querySelectorAll("button, div, span, p, a, [role='button'], [aria-label], [title]"))).filter(n => {
    if (!isRendered(n)) return false;
    const t = buttonText(n);
    if (!t || t.length > 36) return false;
    if (/收起|已展开/.test(t)) return false;
    if (!/(展开全文|展开|全文|更多|查看更多|显示全部)/.test(t)) return false;
    if (/回复|评论/.test(t) && !/全文|显示全部/.test(t)) return false;
    const r = n.getBoundingClientRect();
    if (r.width > 320 || r.height > 90) return false;
    const card = closestCommentCard(n);
    const text = cleanText((card || n.parentElement || n).innerText || "");
    return /\.\.\.|…|全文|展开/.test(text + " " + t);
  });
}

/* ================================================================
 *  评论提取
 * ================================================================ */

function extractVisibleComments() {
  return findCommentCandidates().map(parseCommentNode).filter(Boolean);
}

function findCommentCandidates() {
  const containers = findCommentScrollContainers();
  if (!containers.length) return [];
  const scored = [];
  for (const scope of containers) {
    const nodes = Array.from(scope.querySelectorAll("div, li, article"));
    for (const node of nodes) {
      if (!isRendered(node)) continue;
      const text = cleanText(node.innerText || "");
      if (text.length < COMMENT_TEXT_MIN || text.length > 1800) continue;
      const s = scoreCommentNode(node, text);
      if (s >= 5) scored.push({ node, score: s, len: text.length });
    }
  }
  const unique = [];
  const seen = new Set();
  const sorted = scored.sort((a, b) => b.score - a.score || a.len - b.len).slice(0, MAX_NODE_SCAN);
  for (const item of sorted) {
    const card = shrinkToCommentCard(item.node);
    const k = quickParseNodeKey(card);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    unique.push(card);
  }
  return unique;
}

function countCommentCards() {
  return findCommentCandidates().length;
}

function quickParseNodeKey(node) {
  const text = cleanText(node.innerText || "");
  const lines = text.split("\n").map(cleanText).filter(Boolean);
  if (!lines.length) return "";
  const sel = pickBestUserLink(node);
  const user = cleanText((sel || {}).innerText || lines[0] || "");
  if (!isValidUserName(user)) return "";
  const comment = pickCommentText(lines, user);
  if (!comment || isTimeLike(comment) || comment === "..." || comment === "…") return "";
  return normalizeT(user) + "::" + normalizeT(comment);
}

function scoreCommentNode(node, text) {
  let s = 0;
  if (/回复|点赞|分钟前|小时前|昨天|天前|刚刚|展开/.test(text)) s += 2;
  if (/\d/.test(text)) s += 1;
  if (node.querySelector("a[href*='user'], a[href*='douyin.com/user']")) s += 2;
  if (node.children.length >= 2 && node.children.length <= 16) s += 1;
  if (text.includes("相关推荐") || text.includes("登录") || text.includes("分享给朋友")) s -= 3;
  if (/^\d{1,2}:\d{2}(\/\d{1,2}:\d{2})?/.test(text)) s -= 4;
  if (/^[\d\.]+\s*[万wW]?赞/.test(text)) s -= 2;
  if (NON_USER_NAMES.has(cleanText(text.split("\n")[0] || ""))) s -= 3;
  if (/点击跳转|跳转链接|立即购买|去抖音|抖音APP/.test(text)) s -= 3;
  const r = node.getBoundingClientRect();
  if (r.width < 120 || r.height < 24) s -= 2;
  if (r.width > window.innerWidth * 0.92) s -= 2;
  return s;
}

function shrinkToCommentCard(node) {
  let cur = node;
  for (let i = 0; i < 3; i++) {
    if (!cur.parentElement) break;
    const pt = cleanText(cur.parentElement.innerText || "");
    const ct = cleanText(cur.innerText || "");
    if (pt.length > ct.length * 2.6 || pt.length > 1200) break;
    cur = cur.parentElement;
  }
  return cur;
}

function parseCommentNode(node) {
  const raw = cleanText(node.innerText || "");
  if (!raw) return null;
  const lines = raw.split("\n").map(cleanText).filter(Boolean);
  const filtered = lines.filter(l => !/^回复$|^点赞$|^展开|^收起|^分享$/.test(l));
  if (!filtered.length) return null;
  const userLink = pickBestUserLink(node);
  const userName = cleanText((userLink || {}).innerText || filtered[0] || "");
  if (!isValidUserName(userName)) return null;
  const commentTime = pickTime(filtered);
  const commentText = pickCommentText(filtered, userName);
  if (!commentText || commentText.length < COMMENT_TEXT_MIN) return null;
  if (isTimeLike(commentText) || commentText === commentTime) return null;
  if (commentText === "..." || commentText === "…") return null;
  const ctx = cc.options.collectReplies ? inferCommentContext(node) : { level: "main", parentUserName: "", parentCommentText: "" };
  const imageUrls = extractCommentImageUrls(node);
  const ids = extractCommentIdentity(node);
  return {
    videoUrl: location.href, commentId: ids.commentId, domId: ids.domId,
    userName: userName,
    userProfileUrl: userLink ? safeAbsUrl(userLink.getAttribute("href")) : "",
    commentText: commentText,
    likeCount: pickMetric(filtered, /赞|点赞/),
    replyCount: pickMetric(filtered, /回复/),
    commentTime: commentTime,
    level: ctx.level, parentUserName: ctx.parentUserName, parentCommentText: ctx.parentCommentText,
    replyToUserName: pickReplyToUser(commentText),
    commentImageUrls: imageUrls,
    collectedAt: new Date().toISOString(),
    source: "douyin-web-extension",
    __cardNode: node
  };
}

function extractCommentIdentity(node) {
  const domId = cleanText(node.id || node.getAttribute("data-id") || node.getAttribute("data-comment-id") || node.getAttribute("data-cid") || "");
  const attrs = ["id", "data-id", "data-comment-id", "data-cid", "data-e2e", "data-key", "data-log-id"];
  const parts = [];
  for (const attr of attrs) { const v = node.getAttribute && node.getAttribute(attr); if (v) parts.push(v); }
  for (const el of Array.from(node.querySelectorAll("[id], [data-id], [data-comment-id], [data-cid], [data-e2e], a[href]"))) {
    for (const attr of attrs) { const v = el.getAttribute && el.getAttribute(attr); if (v) parts.push(v); }
    const href = el.getAttribute && el.getAttribute("href"); if (href) parts.push(href);
  }
  const joined = parts.join(" ");
  const cidMatch = joined.match(/(?:comment|cid|reply|comment_id|reply_id)[^\d]{0,8}(\d{6,})/i) || joined.match(/\b(\d{12,})\b/);
  return { commentId: cidMatch ? cidMatch[1] : "", domId };
}

function isValidUserName(name) {
  if (!name || name.length < 1 || name.length > 40) return false;
  if (NON_USER_NAMES.has(name)) return false;
  if (/^\d{1,2}:\d{2}$/.test(name)) return false;
  if (/^\d{1,2}\s*分钟前$|^\d{1,2}\s*小时前$|^\d+\s*天前$/.test(name)) return false;
  return true;
}

function isTimeLike(text) {
  if (!text) return false;
  return /^(刚刚|\d+\s*秒前|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|\d+\s*月前|\d+\s*年前)(\s*[·•]\s*.+)?$/.test(text);
}

function inferCommentContext(node) {
  const container = findCommentScrollContainer() || document.body;
  const nodeRect = node.getBoundingClientRect();
  const nodeLeft = nodeRect.left;
  const nodeText = cleanText(node.innerText || "");

  /* 方法1：文本信号 — "回复 xxx:" 或 "回复了" 等 */
  const replySignal = /^回复\s*[^:： ]+[:：]/.test(nodeText)
    || /回复了|作者回复|二级回复/.test(nodeText)
    || /^回复\s/.test(nodeText);

  /* 方法2：祖先节点 class / data 属性检测 */
  let ancestorReply = false;
  let cur = node.parentElement;
  for (let i = 0; cur && i < 10; i++) {
    const cls = cur.className || "";
    const ds = (cur.dataset && JSON.stringify(cur.dataset)) || "";
    if (/reply|comment-reply|sub-comment|child-comment|reply-item|replyContainer/i.test(cls + " " + ds)) {
      ancestorReply = true;
      break;
    }
    if (cur === container) break;
    cur = cur.parentElement;
  }

  /* 方法3：缩进检测 — 回复评论通常比一级评论有更深的缩进 */
  const cards = findCommentCandidateCards(container).filter(c => c !== node && c.getBoundingClientRect().top < nodeRect.top);
  let parent = null;
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    const r = c.getBoundingClientRect();
    const text = cleanText(c.innerText || "");
    if (!text || text.length > 1600) continue;
    if (r.left < nodeLeft - 8 || /\d+\s*条?回复|展开|查看|更多/.test(text)) { parent = c; break; }
  }

  const hasIndent = parent && (nodeLeft - parent.getBoundingClientRect().left > 8);
  const isReply = replySignal || ancestorReply || hasIndent;

  if (!isReply || !parent) {
    /* 如果有文本信号或祖先reply标记，即使找不到parent也标记为reply */
    if (replySignal || ancestorReply) return { level: "reply", parentUserName: "", parentCommentText: "" };
    return { level: "main", parentUserName: "", parentCommentText: "" };
  }
  const pp = quickParseParent(parent);
  return { level: "reply", parentUserName: pp.userName, parentCommentText: pp.commentText };
}

function quickParseParent(node) {
  const lines = cleanText(node.innerText || "").split("\n").map(cleanText).filter(Boolean);
  const sel = pickBestUserLink(node);
  const user = cleanText((sel || {}).innerText || lines[0] || "");
  return { userName: user, commentText: pickCommentText(lines, user) };
}

function pickReplyToUser(text) {
  const h = String(text || "").match(/^回复\s*([^:： ]+)[:：]/);
  return h ? h[1] : "";
}

function pickCommentText(lines, userName) {
  const blocked = [
    /^\d+$/, /^\d+[万wW]?$/, /回复$/, /点赞$/,
    /刚刚|秒前|分钟前|小时前|昨天|天前|周前|月前|年前|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}/,
    /^(展开|查看|更多|全部).*回复/, /^\d+\s*条?回复$/, /^分享$/
  ];
  const cands = lines.filter(l => l !== userName && l !== "..." && l !== "…" && !blocked.some(p => p.test(l)));
  return cands.sort((a, b) => b.length - a.length)[0] || "";
}

function pickMetric(lines, pattern) {
  const hit = lines.find(l => pattern.test(l));
  if (!hit) return "";
  const n = hit.match(/[\d\.]+\s*[万wW]?/);
  return n ? n[0].replace(/\s+/g, "") : "";
}

function pickTime(lines) {
  const hit = lines.find(l => /刚刚|\d+\s*秒前|\d+\s*分钟前|\d+\s*小时前|昨天|\d+\s*天前|\d+\s*周前|\d+\s*月前|\d+\s*年前|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}/.test(l));
  return hit || "";
}

function extractCommentImageUrls(root) {
  const urls = [];
  /* 0. 优先：在 data-e2e="comment-item" 容器里查找 img（最可靠的层级） */
  /* 实际抖音 DOM:
   *   <div data-e2e="comment-item">
   *     <div class="comment-item-info-wrap">
   *       ...
   *       <div class="cPaPjzrS"><img class="..." src="https://p3-sign.douyinpic.com/...?aweme_comment=1"></div>
   *     </div>
   *   </div>
   * 优先把这种层级里的 img 全部当作评论图。 */
  const isCommentItemRoot = root.matches && (root.matches('[data-e2e="comment-item"]') || root.closest('[data-e2e="comment-item"]'));
  /* 即使 root 不是 comment-item，也尝试找内部的 [aweme_comment] 风格的 img */
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.currentSrc || img.src || img.getAttribute("src") || "";
    /* URL 含 aweme_comment / sign.douyinpic.com 或位于 comment-item 容器 → 直接认定是评论图 */
    const isAwemeCommentUrl = /aweme_comment|sign\.douyinpic|tos-cn-i-[a-z0-9]+\/[A-Za-z0-9]/.test(src);
    const isInsideCommentItem = !!img.closest('[data-e2e="comment-item"]');
    if ((isAwemeCommentUrl || isInsideCommentItem) && !isLikelyAvatar(img) && isRendered(img)) {
      const cands = [src].concat(parseSrcset(img.getAttribute("srcset")));
      for (const u of cands) { const n = normalizeMediaUrl(u); if (n && !urls.includes(n)) urls.push(n); }
      continue;
    }
    /* 走通用判定 */
    if (!isCommentImage(img)) continue;
    const cands = [src].concat(parseSrcset(img.getAttribute("srcset")));
    for (const u of cands) { const n = normalizeMediaUrl(u); if (n && !urls.includes(n)) urls.push(n); }
  }
  /* 2. background-image（抖音有些图片用背景图） */
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.tagName === "IMG" || !isRendered(el)) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") continue;
    const m = bg.match(/url\(["']?(.*?)["']?\)/);
    if (m && m[1]) {
      const n = normalizeMediaUrl(m[1]);
      if (n && !urls.includes(n) && !/avatar|emoji|icon|logo/i.test(n)) urls.push(n);
    }
  }
  return urls;
}

function isCommentImage(img) {
  if (!isRendered(img)) return false;
  const alt = cleanText(img.getAttribute("alt") || "");
  /* 只过滤明显的头像/系统图标，不过滤"表情"——贴纸表情可能用 alt="表情" */
  if (/头像\b|avatar|user-avatar|aweme-avatar|logo|badge/i.test(alt)) return false;
  const src = img.currentSrc || img.src || img.getAttribute("src") || "";
  /* 抖音评论图特征 URL：直接放行 */
  if (/aweme_comment|sign\.douyinpic\.com\/tos-cn-i-/i.test(src)) {
    if (!isLikelyAvatar(img)) return true;
  }
  /* 在 [data-e2e="comment-item"] 容器内的非头像 img → 直接放行 */
  if (img.closest && img.closest('[data-e2e="comment-item"]') && !isLikelyAvatar(img)) {
    const w0 = Number(img.naturalWidth || img.getBoundingClientRect().width || 0);
    const h0 = Number(img.naturalHeight || img.getBoundingClientRect().height || 0);
    if (w0 >= 24 && h0 >= 24) return true;
  }
  /* 排除明确的非评论图片（avatar/logo/icon 文件名） */
  if (/avatar|aweme-avatar|user-avatar|\/logo[._-]|\/icon[._-]|\.svg(\?|$)/i.test(src)) return false;
  if (/data:image\/svg/i.test(src)) return false;
  /* 尺寸检查放宽：抖音评论图片可能只有 30~60px（贴纸表情） */
  const w = Number(img.naturalWidth || img.getBoundingClientRect().width || 0);
  const h = Number(img.naturalHeight || img.getBoundingClientRect().height || 0);
  if (w < 28 || h < 28) return false;
  /* 头像通常严格正方形 + 在评论卡片左侧，且尺寸 36~64 — 用 DOM 上下文判断 */
  if (isLikelyAvatar(img)) return false;
  /* URL特征匹配 - 直接命中 */
  const urlLower = src.toLowerCase();
  if (/tos-cn.*\/object|byteimg|douyinpic|aweme.*image|comment.*image|sticker/i.test(urlLower)) return true;
  if (/\.(jpg|jpeg|png|webp|avif|gif)(\?|$)/i.test(urlLower) && w >= 40 && h >= 40) return true;
  /* 宽高比合理且尺寸够大 → 认为是评论图片 */
  const ratio = w / h;
  if (ratio > 0.2 && ratio < 5 && w >= 36 && h >= 36) return true;
  return false;
}

/* 头像判定：通常是评论卡片中第一个圆形/正方形小图，通常被链接到 user 主页 */
function isLikelyAvatar(img) {
  /* 1. 父级或祖先是用户主页链接 */
  const userLink = img.closest("a[href*='/user/'], a[href*='user/']");
  if (userLink) {
    const r = img.getBoundingClientRect();
    /* 用户链接里的小图就是头像 */
    if (r.width <= 64 && r.height <= 64) return true;
  }
  /* 2. CSS 圆形（border-radius >= 50%） */
  const st = getComputedStyle(img);
  const br = parseFloat(st.borderRadius) || 0;
  const w = img.getBoundingClientRect().width;
  if (w > 0 && br / w >= 0.45 && w <= 64) return true;
  return false;
}

function countVisibleCommentImages() {
  const s = new Set();
  for (const node of findCommentCandidates()) { for (const url of extractCommentImageUrls(node)) s.add(url); }
  return s.size;
}

function parseSrcset(srcset) {
  if (!srcset) return [];
  return srcset.split(",").map(p => p.trim().split(/\s+/)[0]).filter(Boolean);
}

function normalizeMediaUrl(url) {
  if (!url || /^data:|^blob:|^chrome-extension:|^about:/.test(url)) return "";
  try {
    const a = new URL(url, location.href).href;
    /* 图片文件扩展名 */
    if (/\.(jpg|jpeg|png|webp|gif|avif|heic|heif)(\?|$)/i.test(a)) return a;
    /* 抖音/字节系图片CDN */
    if (/image|tos(-cn)?|douyinpic|byteimg|p\d+\.dy|bytedance/i.test(a)) return a;
    /* 通用图片API */
    if (/img.*api|upload.*image|cdn.*img/i.test(a) && !/\.css|\.js(\?|$)/i.test(a)) return a;
    return "";
  } catch(e) { return ""; }
}

/* ================================================================
 *  滚动容器识别
 * ================================================================ */

function findCommentScrollContainers() {
  const locked = findCommentPanelByTab();
  if (locked) return [locked];
  const scored = [];
  const all = Array.from(document.querySelectorAll("div, section, main, aside, article, [role='dialog']"));
  for (const el of all) {
    if (!isRendered(el)) continue;
    const st = getComputedStyle(el);
    const isScrollable = /(auto|scroll|overlay)/.test(st.overflowY) || el.scrollHeight > el.clientHeight + 40;
    if (!isScrollable) continue;
    const txt = cleanText(el.innerText || "");
    const userLinks = el.querySelectorAll("a[href*='user'], a[href*='/user/']").length;
    const keywordHits = (txt.match(/评论|回复|点赞|分钟前|小时前|天前|展开|查看/g) || []).length;
    const r = el.getBoundingClientRect();
    let score = userLinks * 8 + keywordHits * 3 + Math.max(0, el.scrollHeight - el.clientHeight) / 80;
    if (/评论|回复/.test(txt)) score += 12;
    if (r.left > window.innerWidth * 0.35) score += 10;
    if (el.matches('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]')) score += 8;
    if (r.width > window.innerWidth * 0.95) score -= 20;
    if (/首页|朋友|消息|推荐|关注/.test(txt.slice(0, 80))) score -= 8;
    if (score >= 16) scored.push({ el, score });
  }
  const byClass = Array.from(document.querySelectorAll('[class*="comment" i], [class*="Comment" i], [class*="reply" i], [class*="Reply" i], [class*="list" i], [class*="List" i]'))
    .filter(isRendered)
    .map(el => ({ el, score: 14 + el.querySelectorAll("a[href*='user'], a[href*='/user/']").length * 5 }))
    .filter(x => cleanText(x.el.innerText || "").match(/评论|回复|点赞|分钟前|小时前|天前|展开|查看|\d+\s*条?回复/));
  scored.push(...byClass);
  const withDepth = scored.map(item => {
    let depth = 0; let cur = item.el; while (cur.parentElement) { depth++; cur = cur.parentElement; }
    return { ...item, depth };
  });
  const sorted = withDepth.sort((a, b) => b.score !== a.score ? b.score - a.score : b.depth - a.depth);
  const unique = []; const seen = new Set();
  for (const item of sorted) { if (seen.has(item.el)) continue; seen.add(item.el); unique.push(item.el); }
  return unique.slice(0, 6);
}

function findCommentScrollContainer() {
  return findCommentScrollContainers()[0] || null;
}

function findCommentCandidateCards(scope) {
  return Array.from((scope || document.body).querySelectorAll("div, li, article")).filter(isRendered);
}

/* ================================================================
 *  评论 Tab 点击
 * ================================================================ */

async function ensureCommentTabOpen(forceToast) {
  const existing = findCommentScrollContainer();
  if (existing && hasRealCommentSignals(existing)) {
    if (forceToast) showCollectorToast("评论区已打开", "已经识别到右侧评论列表");
    return true;
  }
  const clicked = await clickCommentTabTargets();
  if (clicked) {
    if (forceToast) showCollectorToast("已点击评论区", "评论区已打开");
    await sleep(1600);
    const container = findCommentScrollContainer();
    if (container && hasRealCommentSignals(container)) return true;
  }
  if (forceToast) showCollectorToast("没找到评论列表", "请手动点击右侧评论气泡");
  return false;
}

async function clickCommentTabTargets() {
  const xpathTarget = getByXPath(COMMENT_TAB_XPATH);
  /* 优先用 XPath 命中的元素直接点击（含父级 LI 和 SPAN），抖音 SPAN 不可点 */
  const xpathChain = [];
  if (xpathTarget) {
    xpathChain.push(xpathTarget);
    if (xpathTarget.parentElement) xpathChain.push(xpathTarget.parentElement);
    const tabRoot = xpathTarget.closest("#semiTabcomment");
    if (tabRoot) xpathChain.push(tabRoot);
  }
  const targets = uniqueElements([
    ...xpathChain,
    findSideCommentButton(), findRightCommentTab(),
    document.querySelector("#semiTabcomment"), document.querySelector("#semiTabcomment span")
  ].filter(Boolean));
  console.log("[DouyinCollector] clickCommentTabTargets: 候选 " + targets.length + " 个");
  for (const target of targets) {
    safeScrollIntoCommentView(target);
    await sleep(120);
    for (let i = 0; i < 3; i++) { safeClick(target); forceClickCenter(target); await sleep(260); }
    /* 立刻判定一次，命中就早返 */
    const c = findCommentScrollContainer();
    if (c && hasRealCommentSignals(c)) return true;
  }
  await sleep(500);
  const container = findCommentScrollContainer() || findCommentPanelByTab();
  if (!container || !isRendered(container)) {
    for (let r = 0; r < 2; r++) {
      for (const target of targets) { safeClick(target); forceClickCenter(target); await sleep(220); }
      await sleep(300);
    }
    await sleep(350);
  }
  return targets.length > 0;
}

function findSideCommentButton() {
  const candidates = Array.from(document.querySelectorAll("button, div, span, [role='button'], [aria-label], [title]"))
    .filter(isRendered)
    .map(el => ({ el, text: buttonText(el), rect: el.getBoundingClientRect() }))
    .filter(x => {
      if (x.rect.left < window.innerWidth * 0.55) return false;
      if (x.rect.top < window.innerHeight * 0.18 || x.rect.top > window.innerHeight * 0.78) return false;
      if (x.rect.width > 96 || x.rect.height > 96) return false;
      return /评论|留言|回复|\bcomment\b/i.test(x.text) || /\d+/.test(x.text);
    });
  const commentLike = candidates.filter(x => /评论|留言|回复|comment/i.test(x.text));
  if (commentLike.length) return commentLike.sort((a, b) => Math.abs(a.rect.top - window.innerHeight * 0.48) - Math.abs(b.rect.top - window.innerHeight * 0.48))[0].el;
  return candidates.sort((a, b) => Math.abs(a.rect.top - window.innerHeight * 0.48) - Math.abs(b.rect.top - window.innerHeight * 0.48))[0]?.el || null;
}

function findRightCommentTab() {
  const byXPath = getByXPath(COMMENT_TAB_XPATH);
  if (byXPath && isRendered(byXPath)) return getClickableTabTarget(byXPath);
  const byId = document.querySelector("#semiTabcomment span, #semiTabcomment");
  if (byId && isRendered(byId)) return getClickableTabTarget(byId);
  const candidates = Array.from(document.querySelectorAll("button, a, [role='tab'], [role='button'], div, span"))
    .filter(isRendered)
    .map(el => ({ el, text: exactButtonText(el), rect: el.getBoundingClientRect() }))
    .filter(x => x.text === "评论");
  const topRightTabs = candidates.filter(x => x.rect.top >= 0 && x.rect.top < 90 && x.rect.left > window.innerWidth * 0.55 && x.rect.width >= 20 && x.rect.width <= 90 && x.rect.height >= 14 && x.rect.height <= 48);
  if (topRightTabs.length) return topRightTabs.sort((a, b) => b.rect.left - a.rect.left)[0].el;
  const rightSideTabs = candidates.filter(x => x.rect.left > window.innerWidth * 0.55 && x.rect.width <= 100 && x.rect.height <= 56);
  if (rightSideTabs.length) return rightSideTabs.sort((a, b) => a.rect.top - b.rect.top)[0].el;
  return null;
}

function getClickableTabTarget(el) {
  if (!el) return null;
  return el.closest("#semiTabcomment, [role='tab'], [aria-controls], button, a, [role='button']") || el;
}

function hasNoMoreCommentTip() {
  const scope = findCommentScrollContainer() || findCommentPanelByTab() || document.body;
  return NO_MORE_COMMENT_RE.test(cleanText(scope.innerText || ""));
}

function getByXPath(xpath) {
  try { return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch(e) { return null; }
}

function findCommentPanelByTab() {
  const tab = document.querySelector("#semiTabcomment") || getByXPath(COMMENT_TAB_XPATH);
  if (!tab || !isRendered(tab)) return null;
  const tabRect = tab.getBoundingClientRect();
  const candidates = Array.from(document.querySelectorAll("div, section, main, aside, article, [role='dialog']"))
    .filter(isRendered)
    .filter(el => {
      const r = el.getBoundingClientRect();
      if (r.left < window.innerWidth * 0.45) return false;
      if (r.top < tabRect.top - 20) return false;
      if (r.width < 220 || r.height < 160) return false;
      const st = getComputedStyle(el);
      if (!(/(auto|scroll|overlay)/.test(st.overflowY) || el.scrollHeight > el.clientHeight + 40)) return false;
      return hasRealCommentSignals(el);
    })
    .map(el => {
      const text = cleanText(el.innerText || "");
      const r = el.getBoundingClientRect();
      const links = el.querySelectorAll("a[href*='user'], a[href*='/user/']").length;
      const keywords = (text.match(/回复|点赞|分钟前|小时前|天前|刚刚|展开|查看/g) || []).length;
      return { el, score: links * 10 + keywords * 4 + Math.max(0, el.scrollHeight - el.clientHeight) / 60 - Math.abs(r.top - tabRect.bottom) / 30 };
    })
    .sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].el : null;
}

function hasRealCommentSignals(el) {
  if (!el) return false;
  const text = cleanText(el.innerText || "");
  const userLinks = el.querySelectorAll ? el.querySelectorAll("a[href*='user'], a[href*='/user/']").length : 0;
  const commentWords = (text.match(/回复|点赞|分钟前|小时前|天前|刚刚|展开|查看|条回复/g) || []).length;
  if (userLinks >= 1 && commentWords >= 1) return true;
  if (userLinks >= 2) return true;
  return false;
}

function exactButtonText(el) {
  const t = cleanText(el.innerText || el.textContent || "");
  if (t === "评论") return "评论";
  const aria = cleanText((el.getAttribute && el.getAttribute("aria-label")) || "");
  if (aria === "评论") return "评论";
  const title = cleanText((el.getAttribute && el.getAttribute("title")) || "");
  if (title === "评论") return "评论";
  return t;
}

/* ================================================================
 *  工具函数
 * ================================================================ */

function uniqueElements(list) {
  const out = []; const seen = new Set();
  for (const el of list) { if (!el || seen.has(el)) continue; seen.add(el); out.push(el); }
  return out;
}

function buttonText(el) {
  return cleanText([el.innerText, el.textContent, el.getAttribute && el.getAttribute("aria-label"), el.getAttribute && el.getAttribute("title")].filter(Boolean).join(" "));
}

function closestCommentCard(el) {
  let cur = el;
  for (let i = 0; cur && i < 6; i++) {
    const text = cleanText(cur.innerText || "");
    if (cur.querySelector && cur.querySelector("a[href*='user'], a[href*='/user/']") && /评论|回复|点赞|分钟前|小时前|天前|刚刚|\.\.\.|…/.test(text)) return shrinkToCommentCard(cur);
    cur = cur.parentElement;
  }
  return null;
}

function nearbyCommentText(el) {
  const card = closestCommentCard(el) || el.parentElement;
  return cleanText((card || el).innerText || "");
}

function replyAreaTextLength(el) {
  const card = closestCommentCard(el) || el.parentElement;
  return cleanText((card || el).innerText || "").length;
}

function safeScrollIntoCommentView(el) {
  try {
    const container = findCommentScrollContainer();
    if (container && container.contains(el)) {
      const cr = container.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      container.scrollTop += er.top - cr.top - Math.max(80, cr.height * 0.35);
      return;
    }
    el.scrollIntoView({ block: "center", inline: "nearest" });
  } catch(e) {}
}

function safeClick(el) {
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    el.click();
  } catch(e) { try { el.click(); } catch(err) {} }
}

function forceClickCenter(el) {
  try {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y) || el;
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
  } catch(e) {}
}

function pickBestUserLink(node) {
  const links = Array.from(node.querySelectorAll("a[href*='user'], a[href*='/user/']")).filter(isRendered);
  if (!links.length) return null;
  links.sort((a, b) => { const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect(); return ar.top - br.top || ar.left - br.left; });
  return links[0];
}

function cleanText(text) {
  return String(text || "").replace(/\u200b/g, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function normalizeT(value) {
  return cleanText(value).replace(/https?:\/\/[^\s]+/g, "").replace(/\s+/g, "").replace(/[，。！？、,.!?；;：:\"'“”‘’（）()【】\[\]{}<>《》]/g, "").trim();
}

function normalizeCommentText(value) {
  return normalizeT(value).replace(/^回复[^:：]{1,30}[:：]/, "").replace(/^(作者|楼主|置顶)/, "").replace(/展开全文|收起|查看全部|查看更多/g, "");
}

function normalizedVideoKey(url) {
  try {
    const u = new URL(url || location.href);
    const id = u.searchParams.get("modal_id") || u.searchParams.get("aweme_id") || (u.pathname.match(/\/video\/(\d+)/) || [])[1] || "";
    if (id) return u.origin + "/video/" + id;
    return u.origin + u.pathname.replace(/\/$/, "");
  } catch(e) { return String(url || "").split("?")[0].replace(/\/$/, ""); }
}

function commentKey(c) {
  const idKey = normalizeT(c.commentId || c.domId || "");
  if (idKey && idKey.length >= 6) return normalizedVideoKey(c.videoUrl) + "::id::" + idKey;
  return [normalizedVideoKey(c.videoUrl), normalizeT(c.userName), normalizeCommentText(c.commentText)].join("::");
}

function weakCommentKey(c) {
  return [normalizeT(c.userName), normalizeCommentText(c.commentText)].join("::");
}

function isBetterComment(next, prev) {
  if (!prev) return true;
  const ns = String(next.commentText || "").length + (next.commentId ? 30 : 0) + (next.domId ? 10 : 0) + (next.commentTime ? 5 : 0) + (next.level === "reply" ? 3 : 0);
  const ps = String(prev.commentText || "").length + (prev.commentId ? 30 : 0) + (prev.domId ? 10 : 0) + (prev.commentTime ? 5 : 0) + (prev.level === "reply" ? 3 : 0);
  return ns > ps;
}

function dedupeArr(arr) {
  const byKey = new Map(); const weakToKey = new Map();
  for (const c of (arr || [])) {
    const k = commentKey(c); const wk = weakCommentKey(c);
    if (!k || !wk || wk === "::") continue;
    const existingKey = weakToKey.get(wk) || k;
    const existing = byKey.get(existingKey);
    const finalKey = existing ? existingKey : k;
    if (!existing || isBetterComment(c, existing)) byKey.set(finalKey, c);
    weakToKey.set(wk, finalKey);
  }
  return Array.from(byKey.values());
}

function safeAbsUrl(url) { try { return new URL(url, location.origin).href; } catch(e) { return ""; } }
function sleep(ms) { return new Promise(r => window.setTimeout(r, ms)); }
function cl(val, min, max, fallback) { return Math.min(Math.max(Number(val) || fallback, min), max); }

/* ================================================================
 *  进度与状态
 * ================================================================ */

function emptyProgress() {
  return { tick: 0, added: 0, updated: 0, expandedText: 0, expandedReplies: 0, stableLoops: 0, scrollTop: 0, scrollHeight: 0, visibleCandidates: 0, observerOn: false, phase: "" };
}

function setProgress(phase) {
  cc.progress.phase = phase;
  console.log("[DouyinCollector] " + phase);
  setCommentState("running", phase);
}

function setCommentState(status, message) {
  cc.state = { status, message, running: cc.running, paused: cc.paused, count: cc.comments.length, lastUpdatedAt: new Date().toISOString(), currentUrl: location.href, progress: { ...(cc.progress || emptyProgress()) } };
  updateFloatingPanel();
}

async function persistComments() {
  try {
    cc.comments = dedupeArr(cc.comments);
    await chrome.storage.local.set({ comments: cc.comments, collectorState: cc.state });
  } catch(e) {
    cc.running = false;
    setCommentState("error", "本地存储失败");
    await persistCommentState();
  }
}

async function persistCommentState() {
  try { await chrome.storage.local.set({ collectorState: cc.state }); } catch(e) {}
}

function snapshot() { return { ok: true, state: cc.state }; }

/* ================================================================
 *  悬浮面板
 * ================================================================ */

function ensureFloatingPanel() {
  if (document.getElementById("douyin-comment-collector-float")) return;
  const style = document.createElement("style");
  style.id = "douyin-comment-collector-style";
  style.textContent = `
    #douyin-comment-collector-float { position: fixed; left: 12px; top: 92px; z-index: 2147483647; width: 286px; color: #2a211b; background: rgba(255,252,245,0.96); border: 1px solid rgba(120,96,64,0.18); box-shadow: 0 18px 50px rgba(43,29,16,0.18); border-radius: 18px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; overflow: hidden; backdrop-filter: blur(14px); user-select: none; }
    #douyin-comment-collector-float * { box-sizing: border-box; }
    #douyin-comment-collector-float.wb-mini { width: 58px; height: 58px; border-radius: 999px; overflow: visible; background: linear-gradient(135deg,#fff7ed,#ffe7d1); cursor: pointer; }
    #douyin-comment-collector-float.wb-mini .wb-body, #douyin-comment-collector-float.wb-mini .wb-title, #douyin-comment-collector-float.wb-mini .wb-sub, #douyin-comment-collector-float.wb-mini .wb-badge { display: none; }
    #douyin-comment-collector-float.wb-mini .wb-head { width: 58px; height: 58px; padding: 0; border: 0; border-radius: 999px; justify-content: center; cursor: pointer; background: transparent; }
    #douyin-comment-collector-float.wb-mini .wb-mini-icon { display: flex; }
    #douyin-comment-collector-float .wb-mini-icon { display: none; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 999px; color: #fff; background: linear-gradient(135deg,#c76538,#f2a15f); box-shadow: 0 8px 24px rgba(199,101,56,0.32); font-size: 22px; line-height: 1; }
    #douyin-comment-collector-float .wb-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 10px; cursor: move; background: linear-gradient(135deg,rgba(255,255,255,0.72),rgba(255,243,224,0.7)); border-bottom: 1px solid rgba(120,96,64,0.12); }
    #douyin-comment-collector-float .wb-title { font-weight: 800; font-size: 15px; line-height: 1.1; }
    #douyin-comment-collector-float .wb-sub { font-size: 11px; color: #7b6f64; margin-top: 3px; }
    #douyin-comment-collector-float .wb-badge { font-size: 12px; padding: 5px 8px; border-radius: 999px; background: #fff7ed; color: #b9572e; border: 1px solid rgba(185,87,46,0.22); white-space: nowrap; }
    #douyin-comment-collector-float .wb-body { padding: 12px; }
    #douyin-comment-collector-float .wb-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin-bottom: 10px; }
    #douyin-comment-collector-float .wb-stat { background: #fffaf2; border: 1px solid rgba(120,96,64,0.13); border-radius: 12px; padding: 8px; }
    #douyin-comment-collector-float .wb-stat span { display: block; font-size: 11px; color: #7b6f64; margin-bottom: 3px; }
    #douyin-comment-collector-float .wb-stat strong { font-size: 15px; }
    #douyin-comment-collector-float .wb-msg { min-height: 32px; color: #5f554b; font-size: 12px; line-height: 1.45; background: #fff; border: 1px solid rgba(120,96,64,0.12); border-radius: 12px; padding: 8px; margin-bottom: 10px; }
    #douyin-comment-collector-float .wb-settings { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
    #douyin-comment-collector-float .wb-field label { display: block; font-size: 11px; color: #7b6f64; margin: 0 0 4px 2px; }
    #douyin-comment-collector-float .wb-field input { width: 100%; height: 34px; border-radius: 11px; border: 1px solid rgba(120,96,64,0.18); background: #fff; color: #2a211b; font-size: 13px; padding: 0 9px; outline: none; }
    #douyin-comment-collector-float .wb-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    #douyin-comment-collector-float button { height: 34px; border-radius: 11px; border: 1px solid rgba(120,96,64,0.18); background: #fff; color: #2a211b; font-size: 13px; cursor: pointer; }
    #douyin-comment-collector-float button:hover { background: #fff7ed; }
    #douyin-comment-collector-float button.wb-primary { background: #c76538; color: #fff; border-color: #c76538; }
    #douyin-comment-collector-float button.wb-danger { color: #bd3b35; border-color: rgba(189,59,53,0.25); }
    #douyin-comment-collector-toast { position: fixed; right: 22px; top: 24px; z-index: 99998; min-width: 260px; max-width: 360px; background: rgba(34,27,22,0.94); color: #fff; border-radius: 16px; box-shadow: 0 18px 50px rgba(0,0,0,0.28); padding: 13px 15px; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; transform: translateY(-10px); opacity: 0; transition: opacity .22s ease, transform .22s ease; pointer-events: none; }
    #douyin-comment-collector-toast.wb-show { opacity: 1; transform: translateY(0); }
    #douyin-comment-collector-toast strong { display: block; font-size: 14px; margin-bottom: 3px; }
    #douyin-comment-collector-toast span { display: block; font-size: 12px; color: rgba(255,255,255,0.78); }
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement("div");
  panel.id = "douyin-comment-collector-float";
  panel.innerHTML = `
    <div class="wb-head" data-drag="1">
      <div class="wb-mini-icon" data-action="expand" title="展开">评</div>
      <div><div class="wb-title">抖音评论采集</div><div class="wb-sub">可拖动悬浮面板</div></div>
      <div class="wb-badge" data-role="badge">待机</div>
    </div>
    <div class="wb-body">
      <div class="wb-stats">
        <div class="wb-stat"><span>评论</span><strong data-role="count">0</strong></div>
        <div class="wb-stat"><span>轮次</span><strong data-role="tick">0</strong></div>
        <div class="wb-stat"><span>新增</span><strong data-role="added">0</strong></div>
      </div>
      <div class="wb-settings">
        <div class="wb-field"><label>最大评论</label><input data-role="max-comments" type="number" min="1" max="10000" value="5000"></div>
        <div class="wb-field"><label>间隔ms</label><input data-role="delay-ms" type="number" min="500" max="15000" value="2000"></div>
      </div>
      <div class="wb-msg" data-role="message">点"开始"自动执行：加载→展开→采集</div>
      <div class="wb-row"><button class="wb-primary" data-action="start" data-role="btn-start">开始</button><button data-action="stop" data-role="btn-stop">停止</button></div>
      <div class="wb-row"><button data-action="comment-tab">点评论区</button><button data-action="mini">缩小</button></div>
      <div class="wb-row"><button data-action="dedupe">去重</button><button class="wb-danger" data-action="clear">清空</button></div>
      <div class="wb-row"><button data-action="export-csv">导出 CSV</button><button data-action="export-json">导出 JSON</button></div>
    </div>
  `;
  panel.classList.add("wb-mini");
  document.documentElement.appendChild(panel);
  restoreFloatingPanelPosition(panel);
  bindFloatingPanel(panel);
  updateFloatingPanel();
}

function bindFloatingPanel(panel) {
  let dragging = false; let startX = 0; let startY = 0; let startLeft = 0; let startTop = 0; let draggedDistance = 0;
  const DRAG_THRESHOLD = 4;
  const head = panel.querySelector(".wb-head");
  head.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY; startLeft = r.left; startTop = r.top;
    panel.style.left = r.left + "px"; panel.style.top = r.top + "px"; panel.style.right = "auto";
    e.preventDefault(); e.stopPropagation();
  }, true);
  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const left = Math.min(Math.max(8, startLeft + e.clientX - startX), window.innerWidth - panel.offsetWidth - 8);
    const top = Math.min(Math.max(8, startTop + e.clientY - startY), window.innerHeight - panel.offsetHeight - 8);
    panel.style.left = left + "px"; panel.style.top = top + "px";
  }, true);
  window.addEventListener("mouseup", e => {
    if (!dragging) return;
    draggedDistance = Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY));
    dragging = false;
    chrome.storage.local.set({ floatPanelPosition: { left: panel.style.left, top: panel.style.top } }).catch(() => {});
  }, true);
  panel.addEventListener("click", async e => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) {
      if (draggedDistance > DRAG_THRESHOLD) return;
      if (panel.classList.contains("wb-mini") && e.target.closest(".wb-mini-icon")) panel.classList.remove("wb-mini");
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const action = actionEl.getAttribute("data-action");
    if (action === "expand" && draggedDistance <= DRAG_THRESHOLD) panel.classList.remove("wb-mini");
    if (action === "start") await startComments(readFloatingOptions());
    if (action === "stop") await stopComments("已停止");
    if (action === "dedupe") await dedupeCommentsLocal();
    if (action === "clear") await clearComments();
    if (action === "comment-tab") await ensureCommentTabOpen(true);
    if (action === "mini") panel.classList.add("wb-mini");
    if (action === "export-csv") await exportFloatingComments("csv");
    if (action === "export-json") await exportFloatingComments("json");
    updateFloatingPanel();
  }, true);
}

async function restoreFloatingPanelPosition(panel) {
  try {
    const stored = await chrome.storage.local.get(["floatPanelPosition"]);
    const pos = stored.floatPanelPosition;
    if (pos && pos.left && pos.top) { panel.style.left = pos.left; panel.style.top = pos.top; panel.style.right = "auto"; }
  } catch(e) {}
}

function readFloatingOptions() {
  const panel = document.getElementById("douyin-comment-collector-float");
  const maxInput = panel && panel.querySelector('[data-role="max-comments"]');
  const delayInput = panel && panel.querySelector('[data-role="delay-ms"]');
  const current = cc.options || {};
  return {
    ...current,
    maxComments: cl(Number(maxInput && maxInput.value) || current.maxComments || 5000, 1, 10000, 5000),
    delayMs: cl(Number(delayInput && delayInput.value) || current.delayMs || 2000, 500, 15000, 2000),
    collectReplies: current.collectReplies !== false,
    expandText: current.expandText !== false
  };
}

async function exportFloatingComments(format) {
  const stored = await chrome.storage.local.get(["comments"]);
  const data = dedupeArr(Array.isArray(stored.comments) ? stored.comments : cc.comments || []);
  if (!data.length) { showCollectorToast("暂无评论", "还没有可导出的评论数据"); return; }
  if (format === "json") {
    downloadTextFile(JSON.stringify(data, null, 2), "douyin-comments-" + Date.now() + ".json", "application/json;charset=utf-8");
    showCollectorToast("已导出 JSON", "共 " + data.length + " 条评论"); return;
  }
  downloadTextFile(exportCommentsToCsvLocal(data), "douyin-comments-" + Date.now() + ".csv", "text/csv;charset=utf-8");
  showCollectorToast("已导出 CSV", "共 " + data.length + " 条评论");
}

function exportCommentsToCsvLocal(comments) {
  const headers = ["序号","用户名","用户主页","评论内容","点赞数","回复数","时间","层级","父级用户","被回复人","图片链接","采集时间"];
  const esc = v => { const t = String(v == null ? "" : v).replace(/[\r\n]+/g, " "); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const rows = [headers.join(",")];
  const arr = comments || [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    rows.push([
      i + 1,
      c.userName || "",
      c.userProfileUrl || "",
      c.commentText || "",
      c.likeCount || "",
      c.replyCount || "",
      c.commentTime || "",
      c.level === "reply" ? "回复" : "一级",
      c.parentUserName || "",
      c.replyToUserName || "",
      Array.isArray(c.commentImageUrls) ? c.commentImageUrls.join(" | ") : (c.commentImageUrls || ""),
      (c.collectedAt || "").replace("T", " ").slice(0, 19)
    ].map(esc).join(","));
  }
  return "\uFEFF" + rows.join("\n");
}

function formatCsvCell(value) { return Array.isArray(value) ? value.join(" | ") : (value ?? ""); }
function escapeCsvCell(value) { const t = String(value).replace(/\r?\n/g, " "); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }

function downloadTextFile(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateFloatingPanel() {
  const panel = document.getElementById("douyin-comment-collector-float");
  if (!panel) return;
  const progress = cc.state.progress || cc.progress || {};
  const badge = panel.querySelector('[data-role="badge"]');
  const count = panel.querySelector('[data-role="count"]');
  const tick = panel.querySelector('[data-role="tick"]');
  const added = panel.querySelector('[data-role="added"]');
  const msg = panel.querySelector('[data-role="message"]');
  const maxInput = panel.querySelector('[data-role="max-comments"]');
  const delayInput = panel.querySelector('[data-role="delay-ms"]');
  if (badge) badge.textContent = cc.state.status || "ready";
  if (count) count.textContent = String(cc.state.count || cc.comments.length || 0);
  if (tick) tick.textContent = String(progress.tick || 0);
  if (added) added.textContent = String(progress.added || 0);
  if (msg) msg.textContent = cc.state.message || "Ready";
  if (maxInput && document.activeElement !== maxInput) maxInput.value = String((cc.options && cc.options.maxComments) || 5000);
  if (delayInput && document.activeElement !== delayInput) delayInput.value = String((cc.options && cc.options.delayMs) || 2000);
  /* 按钮状态联动：未运行时开始橙色，运行中停止橙色 */
  const startBtn = panel.querySelector('[data-role="btn-start"]');
  const stopBtn = panel.querySelector('[data-role="btn-stop"]');
  const isRunning = !!cc.running && cc.state.status === "running";
  if (startBtn) startBtn.classList.toggle("wb-primary", !isRunning);
  if (stopBtn)  stopBtn.classList.toggle("wb-primary", isRunning);
}

function showCollectorToast(title, text) {
  let toast = document.getElementById("douyin-comment-collector-toast");
  if (!toast) { toast = document.createElement("div"); toast.id = "douyin-comment-collector-toast"; document.documentElement.appendChild(toast); }
  toast.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(text || "")}</span>`;
  toast.classList.add("wb-show");
  /* 动画结束后移除DOM，不挡页面操作 */
  if (toast._timer) clearTimeout(toast._timer);
  toast._timer = window.setTimeout(() => {
    toast.classList.remove("wb-show");
    window.setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 2800);
}

function escapeHtml(value) { return String(value || "").replace(/[&<>"]/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[s])); }

ensureFloatingPanel();

window.addEventListener("beforeunload", () => {});

})();
