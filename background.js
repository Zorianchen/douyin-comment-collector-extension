chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["collectorState", "comments"]);
  if (!existing.collectorState) {
    await chrome.storage.local.set({
      collectorState: {
        running: false,
        paused: false,
        status: "ready",
        message: "Ready",
        count: 0,
        lastUpdatedAt: null,
        currentUrl: null
      },
      comments: []
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "download") {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: true
    }, downloadId => {
      sendResponse({ ok: !chrome.runtime.lastError, downloadId, error: chrome.runtime.lastError?.message });
    });
    return true;
  }

  return false;
});
