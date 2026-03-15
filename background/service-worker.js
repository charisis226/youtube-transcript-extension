// background/service-worker.js
// Service Worker for YouTube Transcript to Docs extension

import { extractTranscript, fetchVideoMetadata } from "../lib/youtube-api.js";
import { appendVideoSection } from "../lib/docs-api.js";
import { summarize, describeThumbnail } from "../lib/gemini-api.js";

// ── Installed handler ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.storage.local.set({ firstRun: true });
    chrome.action.setBadgeText({ text: "NEW" });
    chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
  }
});

// ── Open side panel when action icon is clicked ──────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "VIDEO_CHANGED":
      handleVideoChanged(message);
      break;

    case "GET_CURRENT_VIDEO":
      handleGetCurrentVideo(sendResponse);
      return true; // async

    case "GET_AUTH_TOKEN":
      handleGetAuthToken(sendResponse);
      return true; // async

    case "SAVE_TRANSCRIPT":
      handleSaveTranscript(message, sendResponse);
      return true; // async

    case "GET_HISTORY":
      handleGetHistory(sendResponse);
      return true; // async
  }
});

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleVideoChanged({ videoId, title, channelTitle, captionTracks }) {
  chrome.storage.session.set({ videoId, title, channelTitle, captionTracks });
}

async function handleGetCurrentVideo(sendResponse) {
  const data = await chrome.storage.session.get([
    "videoId",
    "title",
    "channelTitle",
    "captionTracks",
  ]);

  if (data.videoId) {
    sendResponse(data);
    return;
  }

  // Fallback: query the active tab directly if session storage is empty
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes("youtube.com/watch")) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          const videoId = new URLSearchParams(window.location.search).get("v");
          if (!videoId) return null;
          const playerResponse = window.ytInitialPlayerResponse;
          const captionTracks =
            playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const title =
            document.querySelector("h1.ytd-video-primary-info-renderer")?.textContent?.trim() ||
            document.querySelector("h1.style-scope.ytd-watch-metadata")?.textContent?.trim() ||
            document.title.replace(" - YouTube", "").trim();
          const channelTitle =
            document.querySelector("#channel-name #text")?.textContent?.trim() ||
            document.querySelector("ytd-channel-name #text")?.textContent?.trim() ||
            "";
          return { videoId, title, channelTitle, captionTracks };
        },
      });
      const videoInfo = results?.[0]?.result;
      if (videoInfo?.videoId) {
        await chrome.storage.session.set(videoInfo);
        sendResponse(videoInfo);
        return;
      }
    }
  } catch {
    // fallthrough
  }

  sendResponse(data);
}

async function handleGetAuthToken(sendResponse) {
  try {
    const token = await chrome.identity.getAuthToken({ interactive: true });
    sendResponse({ token });
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

async function handleGetHistory(sendResponse) {
  const { history = [] } = await chrome.storage.local.get("history");
  sendResponse({ history });
}

async function handleSaveTranscript(message, sendResponse) {
  const { captionTracks, videoId, title, channelTitle, options } = message;
  // options: { includeTimeline, summarize: boolean, language, docId, authToken, geminiKey }

  function notify(step, status, detail = "") {
    // Try to send progress to side panel (best-effort)
    chrome.runtime
      .sendMessage({ type: "SAVE_PROGRESS", step, status, detail })
      .catch(() => {});
  }

  try {
    // Step 1: Extract transcript
    notify("transcript", "loading");
    const transcript = await extractTranscript(
      captionTracks,
      options.includeTimeline
    );
    notify("transcript", "done");

    // Step 2: Fetch metadata
    notify("metadata", "loading");
    const metadata = await fetchVideoMetadata(videoId, options.authToken);
    notify("metadata", "done");

    // Step 3: Thumbnail description (optional)
    let thumbnailDescription = null;
    if (options.geminiKey && metadata.thumbnailUrl) {
      notify("thumbnail", "loading");
      try {
        thumbnailDescription = await describeThumbnail(
          metadata.thumbnailUrl,
          options.geminiKey
        );
        notify("thumbnail", "done");
      } catch (err) {
        notify("thumbnail", "error", err.message);
      }
    }

    // Step 4: Summarize (optional)
    let summary = null;
    if (options.geminiKey && options.summarize) {
      notify("summary", "loading");
      try {
        summary = await summarize(transcript, options.language, options.geminiKey);
        notify("summary", "done");
      } catch (err) {
        notify("summary", "error", err.message);
      }
    }

    // Step 5: Save to Google Docs
    notify("docs", "loading");
    await appendVideoSection(options.docId, options.authToken, {
      videoId,
      title,
      channelTitle,
      metadata,
      transcript,
      thumbnailDescription,
      summary,
      includeTimeline: options.includeTimeline,
    });
    notify("docs", "done");

    // Step 6: Save to history
    const entry = {
      videoId,
      title,
      channelTitle,
      thumbnailUrl: metadata.thumbnailUrl || null,
      savedAt: new Date().toISOString(),
      docId: options.docId,
    };
    await saveHistory(entry);

    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

async function saveHistory(entry) {
  const { history = [] } = await chrome.storage.local.get("history");
  // Dedup by videoId — keep latest
  const filtered = history.filter((h) => h.videoId !== entry.videoId);
  // Cap at 20 entries (most recent first)
  const updated = [entry, ...filtered].slice(0, 20);
  await chrome.storage.local.set({ history: updated });
}
