/* ── DOM refs ── */
const stateEls = {
  pageHint: document.getElementById("pageHint"),
  statusBadge: document.getElementById("statusBadge"),
  count: document.getElementById("count"),
  statusText: document.getElementById("statusText"),
  message: document.getElementById("message"),
  collectMode: document.getElementById("collectMode"),
  maxCommentsField: document.getElementById("maxCommentsField"),
  maxComments: document.getElementById("maxComments"),
  delayMs: document.getElementById("delayMs"),
  collectReplies: document.getElementById("collectReplies"),
  expandText: document.getElementById("expandText"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  dedupeBtn: document.getElementById("dedupeBtn"),
  clearBtn: document.getElementById("clearBtn"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn")
};

let activeTab = null;

/* ── Tab utils ── */
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isDouyinUrl(url) {
  return /^https:\/\/(www\.)?(douyin|iesdouyin)\.com\//.test(url || "");
}

/* ── Messaging ── */
async function sendToContent(type, payload = {}) {
  if (!activeTab?.id) throw new Error("没有可用的当前标签页");
  try {
    return await chrome.tabs.sendMessage(activeTab.id, { type, ...payload });
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    await injectContentScript(activeTab.id);
    await wait(200);
    return chrome.tabs.sendMessage(activeTab.id, { type, ...payload });
  }
}

function isConnectionError(error) {
  const msg = error?.message || String(error || "");
  return msg.includes("Could not establish connection") || msg.includes("Receiving end does not exist");
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

function wait(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/* ── 采集模式：采全部时隐藏「目标条数」 ── */
function syncModeUI() {
  if (!stateEls.collectMode || !stateEls.maxCommentsField) return;
  stateEls.maxCommentsField.style.display = stateEls.collectMode.value === "all" ? "none" : "";
}

/* ── State ── */
async function loadState() {
  activeTab = await getActiveTab();
  const canRun = isDouyinUrl(activeTab?.url);
  stateEls.pageHint.textContent = canRun ? "当前是抖音页面，可以采集" : "请先打开抖音页面";

  const disable = !canRun;
  for (const el of [stateEls.startBtn, stateEls.stopBtn, stateEls.dedupeBtn, stateEls.clearBtn]) {
    el.disabled = disable;
  }

  const { collectorState, comments } = await chrome.storage.local.get(["collectorState", "comments"]);
  const commentCount = (comments || []).length || (collectorState && collectorState.count) || 0;

  stateEls.count.textContent = String(commentCount);
  stateEls.statusText.textContent = statusLabel(collectorState?.status || "ready");
  stateEls.statusBadge.textContent = statusLabel(collectorState?.status || "ready");
  stateEls.message.textContent = collectorState?.message || "提示：建议直接在抖音页面右下角的悬浮面板操作，更直观。打开评论区后点「开始采集」。";

  stateEls.exportCsvBtn.disabled = commentCount === 0;
  stateEls.exportJsonBtn.disabled = commentCount === 0;
}

function statusLabel(status) {
  const map = { ready: "待机", running: "采集中", paused: "已暂停", stopped: "已停止", done: "已完成", error: "异常" };
  return map[status] || status;
}

function readOptions() {
  return {
    collectAll: stateEls.collectMode.value === "all",
    maxComments: clamp(Number(stateEls.maxComments.value) || 2000, 1, 10000),
    delayMs: clamp(Number(stateEls.delayMs.value) || 2000, 500, 15000),
    collectReplies: Boolean(stateEls.collectReplies.checked),
    expandText: Boolean(stateEls.expandText.checked)
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* ── Generic action helper ── */
async function updateFromContent(action, payload = {}) {
  try {
    await sendToContent(action, payload);
    await loadState();
  } catch (error) {
    if (isConnectionError(error)) {
      stateEls.message.textContent = "连接页面脚本失败。请刷新抖音页面后再试，或确认当前标签页是抖音页面。";
      return;
    }
    stateEls.message.textContent = `操作失败：${error.message || error}`;
  }
}

/* ── Comment events ── */
stateEls.collectMode.addEventListener("change", syncModeUI);
stateEls.startBtn.addEventListener("click", () => updateFromContent("collector:start", { options: readOptions() }));
stateEls.stopBtn.addEventListener("click", () => updateFromContent("collector:stop"));
stateEls.dedupeBtn.addEventListener("click", () => updateFromContent("collector:dedupe"));
stateEls.clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ comments: [], collectorState: resetState("ready", "已清空本地评论数据") });
  await updateFromContent("collector:clear").catch(() => loadState());
});

stateEls.exportCsvBtn.addEventListener("click", async () => {
  const { comments } = await chrome.storage.local.get(["comments"]);
  const data = dedupeComments(comments || []);
  downloadText(exportCommentsToCsv(data), `douyin-comments-${ts()}.csv`, "text/csv;charset=utf-8");
});

stateEls.exportJsonBtn.addEventListener("click", async () => {
  const { comments } = await chrome.storage.local.get(["comments"]);
  downloadText(JSON.stringify(dedupeComments(comments || []), null, 2), `douyin-comments-${ts()}.json`, "application/json;charset=utf-8");
});

/* ── Storage listener ── */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.collectorState || changes.comments) loadState();
});

function resetState(status, message) {
  return { status, message, count: 0, lastUpdatedAt: new Date().toISOString(), currentUrl: "" };
}

function ts() {
  return Date.now();
}

syncModeUI();
loadState();
