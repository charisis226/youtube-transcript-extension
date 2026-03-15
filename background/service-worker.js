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

    case "LOGIN":
      handleLogin(sendResponse);
      return true;


    case "LOGOUT":
      handleLogout(sendResponse);
      return true;

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
  // Silent check — returns stored token if still valid
  const { authToken, authTokenExpiry } = await chrome.storage.local.get([
    "authToken",
    "authTokenExpiry",
  ]);
  if (authToken && authTokenExpiry && Date.now() < authTokenExpiry) {
    sendResponse({ token: authToken });
  } else {
    sendResponse({});
  }
}

async function handleLogin(sendResponse) {
  try {
    const clientId = chrome.runtime.getManifest().oauth2.client_id;
    const scopes = chrome.runtime.getManifest().oauth2.scopes;
    const redirectUri = chrome.identity.getRedirectURL();

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "token");
    authUrl.searchParams.set("scope", scopes.join(" "));
    authUrl.searchParams.set("prompt", "select_account");

    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });

    const hash = new URL(responseUrl).hash.slice(1);
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    const expiresIn = parseInt(params.get("expires_in") || "3600", 10);

    if (token) {
      await chrome.storage.local.set({
        authToken: token,
        authTokenExpiry: Date.now() + (expiresIn - 300) * 1000,
      });
      sendResponse({ token });
    } else {
      sendResponse({ error: "토큰을 받지 못했습니다." });
    }
  } catch (error) {
    const redirectUri = chrome.identity.getRedirectURL();
    sendResponse({ error: `${error.message} | redirect_uri: ${redirectUri}` });
  }
}

async function handleLogout(sendResponse) {
  await chrome.storage.local.remove(["authToken", "authTokenExpiry"]);
  sendResponse({ success: true });
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
    // Step 1: Extract transcript via Innertube API
    notify("transcript", "loading");
    const transcript = await extractTranscript(captionTracks, options.includeTimeline, videoId);
    notify("transcript", "done");

    // Step 2: Fetch metadata (fallback to basic info if API unavailable)
    notify("metadata", "loading");
    let metadata;
    try {
      metadata = await fetchVideoMetadata(videoId, options.authToken);
    } catch (err) {
      metadata = {
        title,
        channelTitle,
        publishedAt: "",
        viewCount: "0",
        tags: [],
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    }
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

async function makePageContextFetcher() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    return (url) =>
      new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: "FETCH_URL", url }, (response) => {
          resolve(response?.text || "");
        });
      });
  } catch {
    return null;
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
