// sidepanel/panel.js

// ── Tab switching ────────────────────────────────────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tabId = btn.dataset.tab;
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));

    btn.classList.add("active");
    const content = document.getElementById(`tab-${tabId}`);
    content.classList.remove("hidden");
    content.classList.add("active");

    if (tabId === "history") loadHistory();
  });
});

// ── Cached state ─────────────────────────────────────────────────────────────

let currentVideo = null;   // { videoId, title, channelTitle, captionTracks }
let authToken = null;
let docId = null;
let geminiKey = null;

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Check firstRun — show settings tab on first use
  const { firstRun } = await chrome.storage.local.get("firstRun");
  if (firstRun) {
    switchTab("settings");
    await chrome.storage.local.remove("firstRun");
    await chrome.action.setBadgeText({ text: "" });
  }

  // Load stored settings
  const stored = await chrome.storage.local.get(["docId", "geminiKey"]);
  docId = stored.docId || "";
  geminiKey = stored.geminiKey || "";

  if (docId) document.getElementById("input-doc-id").value = docId;
  if (geminiKey) document.getElementById("input-gemini-key").value = geminiKey;

  // Check auth
  await refreshAuthStatus();

  // Get current video
  const video = await chrome.runtime.sendMessage({ type: "GET_CURRENT_VIDEO" });
  if (video?.videoId) {
    updateVideoUI(video);
  } else {
    showSaveError("no-video");
  }
}

init();

// ── Auth ──────────────────────────────────────────────────────────────────────

async function refreshAuthStatus() {
  const errorEl = document.getElementById("auth-error");
  errorEl.classList.add("hidden");

  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_AUTH_TOKEN" });
    if (result?.token) {
      authToken = result.token;
      setAuthUI(true);
    } else {
      authToken = null;
      setAuthUI(false);
      if (result?.error) {
        errorEl.textContent = `로그인 실패: ${result.error}`;
        errorEl.classList.remove("hidden");
      }
    }
  } catch (e) {
    authToken = null;
    setAuthUI(false);
    errorEl.textContent = `로그인 오류: ${e.message}`;
    errorEl.classList.remove("hidden");
  }
}

function setAuthUI(loggedIn) {
  const status = document.getElementById("auth-status");
  const loginBtn = document.getElementById("btn-login");
  const logoutBtn = document.getElementById("btn-logout");

  if (loggedIn) {
    status.textContent = "✅ Google 계정 연결됨";
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");
  } else {
    status.textContent = "로그인이 필요합니다.";
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
  }
  updateSaveButton();
}

document.getElementById("btn-login").addEventListener("click", async () => {
  const errorEl = document.getElementById("auth-error");
  errorEl.classList.add("hidden");
  document.getElementById("btn-login").disabled = true;

  const result = await chrome.runtime.sendMessage({ type: "LOGIN" }).catch((e) => ({
    error: e.message,
  }));

  document.getElementById("btn-login").disabled = false;

  if (result?.token) {
    authToken = result.token;
    setAuthUI(true);
  } else {
    errorEl.textContent = `로그인 실패: ${result?.error || "알 수 없는 오류"}`;
    errorEl.classList.remove("hidden");
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "LOGOUT" });
  authToken = null;
  setAuthUI(false);
});

// ── Settings ──────────────────────────────────────────────────────────────────

document.getElementById("btn-save-settings").addEventListener("click", async () => {
  docId = document.getElementById("input-doc-id").value.trim();
  await chrome.storage.local.set({ docId });
  showSettingsSaved();
  updateSaveButton();
});

document.getElementById("btn-save-gemini").addEventListener("click", async () => {
  geminiKey = document.getElementById("input-gemini-key").value.trim();
  await chrome.storage.local.set({ geminiKey });
  showSettingsSaved();
});

function showSettingsSaved() {
  const el = document.getElementById("settings-saved");
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2000);
}

// ── Video UI ─────────────────────────────────────────────────────────────────

function updateVideoUI(video) {
  currentVideo = video;

  // Hide all errors
  ["no-video", "no-caption", "no-settings"].forEach(hideError);

  const hasCaptions = video.captionTracks?.length > 0;
  if (!hasCaptions) {
    showSaveError("no-caption");
    updateSaveButton();
    return;
  }

  const card = document.getElementById("video-info");
  card.classList.remove("hidden");

  const thumb = document.getElementById("thumbnail");
  if (video.videoId) {
    thumb.src = `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`;
  }
  document.getElementById("video-title").textContent = video.title || "";
  document.getElementById("video-channel").textContent = video.channelTitle || "";

  document.getElementById("save-options").classList.remove("hidden");
  updateSaveButton();
}

function showSaveError(type) {
  document.getElementById(`error-${type}`)?.classList.remove("hidden");
}

function hideError(type) {
  document.getElementById(`error-${type}`)?.classList.add("hidden");
}

function updateSaveButton() {
  const btn = document.getElementById("btn-save");
  const hasVideo = currentVideo?.videoId;
  const hasCaptions = currentVideo?.captionTracks?.length > 0;
  const hasDoc = !!docId;
  const hasAuth = !!authToken;

  btn.disabled = !(hasVideo && hasCaptions && hasDoc && hasAuth);

  if (hasVideo && hasCaptions && !hasDoc) showSaveError("no-settings");
  if (hasDoc || !hasVideo) hideError("no-settings");
}

// ── Listen for VIDEO_CHANGED from content script ──────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "VIDEO_CHANGED") {
    // Reset UI
    document.getElementById("video-info").classList.add("hidden");
    document.getElementById("save-options").classList.add("hidden");
    document.getElementById("progress-list").classList.add("hidden");
    document.getElementById("save-result").classList.add("hidden");
    resetProgress();
    updateVideoUI(message);
  }

  if (message.type === "SAVE_PROGRESS") {
    updateProgress(message.step, message.status);
  }
});

// ── Save flow ─────────────────────────────────────────────────────────────────

document.getElementById("btn-save").addEventListener("click", async () => {
  if (!currentVideo || !authToken || !docId) return;

  const includeTimeline = document.getElementById("opt-timeline").checked;
  const doSummarize = document.getElementById("opt-summary").checked;
  const language = document.getElementById("opt-language").value;

  // Show progress
  const progressList = document.getElementById("progress-list");
  progressList.classList.remove("hidden");
  resetProgress();

  const resultEl = document.getElementById("save-result");
  resultEl.classList.add("hidden");

  // Show/hide optional steps
  setOptionalStepVisibility(doSummarize, !!geminiKey);

  document.getElementById("btn-save").disabled = true;

  const response = await chrome.runtime.sendMessage({
    type: "SAVE_TRANSCRIPT",
    videoId: currentVideo.videoId,
    title: currentVideo.title,
    channelTitle: currentVideo.channelTitle,
    captionTracks: currentVideo.captionTracks,
    options: {
      includeTimeline,
      summarize: doSummarize,
      language,
      docId,
      authToken,
      geminiKey: geminiKey || null,
    },
  });

  document.getElementById("btn-save").disabled = false;

  resultEl.classList.remove("hidden");
  if (response?.success) {
    resultEl.textContent = "✅ Google Docs에 저장되었습니다!";
    resultEl.className = "save-result success";
  } else {
    resultEl.textContent = `❌ 저장 실패: ${response?.error || "알 수 없는 오류"}`;
    resultEl.className = "save-result error";
  }
});

function resetProgress() {
  document.querySelectorAll(".progress-list li").forEach((li) => {
    li.className = "";
    li.querySelector(".progress-icon").textContent = "○";
  });
}

function setOptionalStepVisibility(doSummarize, hasGemini) {
  const showOptional = doSummarize && hasGemini;
  document.querySelectorAll(".progress-list li.optional").forEach((li) => {
    li.style.display = showOptional ? "" : "none";
  });
}

function updateProgress(step, status) {
  const li = document.querySelector(`.progress-list li[data-step="${step}"]`);
  if (!li) return;

  const icon = li.querySelector(".progress-icon");
  li.className = status;
  if (status === "loading") icon.textContent = "⏳";
  else if (status === "done") icon.textContent = "✅";
  else if (status === "error") icon.textContent = "❌";
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory() {
  const response = await chrome.runtime.sendMessage({ type: "GET_HISTORY" });
  const history = response?.history || [];
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");

  list.textContent = "";

  if (history.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  history.forEach((entry) => {
    list.appendChild(buildHistoryCard(entry));
  });
}

function buildHistoryCard(entry) {
  const li = document.createElement("li");
  li.className = "history-card";

  const thumb = document.createElement("img");
  thumb.className = "history-thumb";
  thumb.src = entry.thumbnailUrl || `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg`;
  thumb.alt = "썸네일";
  li.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "history-info";

  const titleEl = document.createElement("p");
  titleEl.className = "history-title";
  titleEl.textContent = entry.title || "제목 없음";
  info.appendChild(titleEl);

  const channelEl = document.createElement("p");
  channelEl.className = "history-channel";
  channelEl.textContent = entry.channelTitle || "";
  info.appendChild(channelEl);

  const dateEl = document.createElement("p");
  dateEl.className = "history-date";
  dateEl.textContent = new Date(entry.savedAt).toLocaleDateString("ko-KR");
  info.appendChild(dateEl);

  if (entry.docId) {
    const link = document.createElement("a");
    link.className = "history-link";
    link.href = `https://docs.google.com/document/d/${entry.docId}/edit`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "문서 열기 →";
    info.appendChild(link);
  }

  li.appendChild(info);
  return li;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-content").forEach((c) => {
    const isTarget = c.id === `tab-${tabId}`;
    c.classList.toggle("hidden", !isTarget);
    c.classList.toggle("active", isTarget);
  });
}
