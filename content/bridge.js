// content/bridge.js
// Runs in ISOLATED world — bridges postMessage from MAIN world to chrome.runtime

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "yt-transcript-ext") return;

  const { source, ...message } = event.data;
  chrome.runtime.sendMessage(message).catch(() => {});
});
