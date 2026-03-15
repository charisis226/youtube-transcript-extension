// content/bridge.js
// Runs in ISOLATED world — bridges postMessage from MAIN world to chrome.runtime

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "yt-transcript-ext") return;

  const { source, ...message } = event.data;
  chrome.runtime.sendMessage(message).catch(() => {});
});

// Fetch URLs on behalf of the service worker (uses page cookies)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FETCH_URL") {
    fetch(message.url)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => sendResponse({ text }))
      .catch(() => sendResponse({ text: "" }));
    return true; // keep channel open for async response
  }
});
