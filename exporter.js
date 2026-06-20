/* ── Comment export ── */
function exportCommentsToCsv(comments) {
  const headers = [
    "videoUrl", "commentId", "domId", "userName", "userProfileUrl", "commentText",
    "likeCount", "replyCount", "commentTime",
    "level", "parentUserName", "parentCommentText", "replyToUserName",
    "commentImageUrls", "collectedAt", "source"
  ];
  return exportRowsToCsv(dedupeComments(comments || []), headers);
}

function dedupeComments(comments) {
  const byKey = new Map();
  const weakToKey = new Map();
  for (const c of comments || []) {
    const key = stableCommentKey(c);
    const weakKey = stableWeakCommentKey(c);
    if (!key || !weakKey || weakKey === "::") continue;
    const existingKey = weakToKey.get(weakKey) || key;
    const existing = byKey.get(existingKey);
    const finalKey = existing ? existingKey : key;
    if (!existing || isBetterExportComment(c, existing)) byKey.set(finalKey, c);
    weakToKey.set(weakKey, finalKey);
  }
  return Array.from(byKey.values());
}

function stableCommentKey(c) {
  const idKey = normalizeText(c?.commentId || c?.domId || "");
  if (idKey && idKey.length >= 6) return `${normalizeWorkUrl(c?.videoUrl)}::id::${idKey}`;
  return [normalizeWorkUrl(c?.videoUrl), normalizeText(c?.userName), normalizeCommentText(c?.commentText)].join("::");
}

function stableWeakCommentKey(c) {
  return [normalizeText(c?.userName), normalizeCommentText(c?.commentText)].join("::");
}

function isBetterExportComment(next, prev) {
  const nextScore = String(next?.commentText || "").length + (next?.commentId ? 30 : 0) + (next?.domId ? 10 : 0) + (next?.commentTime ? 5 : 0) + (next?.level === "reply" ? 3 : 0);
  const prevScore = String(prev?.commentText || "").length + (prev?.commentId ? 30 : 0) + (prev?.domId ? 10 : 0) + (prev?.commentTime ? 5 : 0) + (prev?.level === "reply" ? 3 : 0);
  return nextScore > prevScore;
}

/* ── Shared helpers ── */
function normalizeText(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?；;：:\"'“”‘’（）()【】\[\]{}<>《》]/g, "")
    .trim();
}

function normalizeCommentText(value) {
  return normalizeText(value)
    .replace(/^回复[^:：]{1,30}[:：]/, "")
    .replace(/^(作者|楼主|置顶)/, "")
    .replace(/展开全文|收起|查看全部|查看更多/g, "");
}

function normalizeWorkUrl(url) {
  try {
    const parsed = new URL(url || "");
    const id = parsed.searchParams.get("modal_id") || parsed.searchParams.get("aweme_id") || (parsed.pathname.match(/\/video\/(\d+)/) || [])[1] || "";
    if (id) return `${parsed.origin}/video/${id}`;
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(url || "").split("?")[0].replace(/\/$/, "");
  }
}

function exportRowsToCsv(rowsData, headers) {
  const rows = [headers.join(",")];
  for (const row of rowsData || []) {
    rows.push(headers.map(h => escapeCsv(formatCell(row[h]))).join(","));
  }
  return "\uFEFF" + rows.join("\n");
}

function formatCell(value) {
  if (Array.isArray(value)) return value.join(" | ");
  return value ?? "";
}

function escapeCsv(value) {
  const text = String(value).replace(/\r?\n/g, " ");
  if (/[",\n]/.test(text)) return "\"" + text.replace(/"/g, "\"\"") + "\"";
  return text;
}

function downloadText(text, filename, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
