// content/bridge.js
// Runs in ISOLATED world — bridges postMessage from MAIN world to chrome.runtime

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "yt-transcript-ext") return;

  const { source, ...message } = event.data;
  chrome.runtime.sendMessage(message).catch(() => {});
});

// Handle requests from service worker that need page context (cookies, browser headers)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FETCH_URL") {
    fetch(message.url)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => sendResponse({ text }))
      .catch(() => sendResponse({ text: "" }));
    return true;
  }

  if (message.type === "GET_TRANSCRIPT_DATA") {
    fetch("https://www.youtube.com/youtubei/v1/get_transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.body),
    })
      .then((r) => r.text())
      .then((text) => sendResponse({ text }))
      .catch((e) => sendResponse({ text: "", error: e.message }));
    return true;
  }
});
