// lib/youtube-api.js
// YouTube transcript extraction and video metadata

/**
 * Extract transcript text from caption tracks.
 * @param {Array} captionTracks - from ytInitialPlayerResponse
 * @param {boolean} includeTimeline - whether to prefix lines with [MM:SS]
 * @returns {string} transcript text
 */
export async function extractTranscript(captionTracks, includeTimeline = false, videoId = "") {
  if (!captionTracks || captionTracks.length === 0) {
    throw new Error("자막을 찾을 수 없습니다.");
  }

  const track = selectBestTrack(captionTracks);

  // Build URL from scratch using public timedtext API (baseUrl can expire)
  let url;
  if (videoId && track.languageCode) {
    const params = new URLSearchParams({ v: videoId, lang: track.languageCode, fmt: "srv1" });
    if (track.kind === "asr") params.set("kind", "asr");
    url = `https://www.youtube.com/api/timedtext?${params}`;
  } else {
    url = track.baseUrl;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`자막 fetch 실패: ${response.status}`);
  }

  const xml = await response.text();
  const segments = parseTimedText(xml);

  if (segments.length === 0) {
    throw new Error("자막 파싱 실패: " + xml.slice(0, 300));
  }

  if (includeTimeline) {
    return segments
      .map(({ start, text }) => `[${formatTime(start)}] ${text}`)
      .join("\n");
  } else {
    return segments.map(({ text }) => text).join(" ");
  }
}

/**
 * Select the best caption track:
 * - Prefer manual captions over auto-generated
 * - Prefer page language, then Korean, then first available
 */
function selectBestTrack(tracks) {
  const pageLanguage = navigator?.language?.split("-")[0] || "ko";

  const manual = tracks.filter(
    (t) => !t.kind || t.kind !== "asr"
  );
  const auto = tracks.filter((t) => t.kind === "asr");

  const findByLang = (list, lang) =>
    list.find((t) => t.languageCode?.startsWith(lang));

  return (
    findByLang(manual, pageLanguage) ||
    findByLang(manual, "ko") ||
    manual[0] ||
    findByLang(auto, pageLanguage) ||
    findByLang(auto, "ko") ||
    auto[0] ||
    tracks[0]
  );
}

/**
 * Parse YouTube timedtext XML into segments.
 * @returns {Array<{start: number, dur: number, text: string}>}
 */
function parseTimedText(xml) {
  const results = [];

  // Format 1: srv1 — <text start="X" dur="Y">content</text>
  const textRegex = /<text([^>]*)>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const content = match[2].replace(/<[^>]*>/g, "");
    const start = parseFloat((/start="([^"]*)"/.exec(attrs) || [])[1] || "0");
    const dur = parseFloat((/dur="([^"]*)"/.exec(attrs) || [])[1] || "0");
    results.push({ start, dur, text: decodeHTMLEntities(content) });
  }
  if (results.length > 0) return results;

  // Format 2: srv3 — <p t="X" d="Y">content</p> (time in ms)
  const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/g;
  while ((match = pRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const content = match[2].replace(/<[^>]*>/g, "");
    const t = parseInt((/\bt="([^"]*)"/.exec(attrs) || [])[1] || "0", 10);
    const d = parseInt((/\bd="([^"]*)"/.exec(attrs) || [])[1] || "0", 10);
    results.push({ start: t / 1000, dur: d / 1000, text: decodeHTMLEntities(content) });
  }

  return results;
}


function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n/g, " ")
    .trim();
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Fetch video metadata from YouTube Data API v3.
 * @param {string} videoId
 * @param {string} authToken - OAuth token
 * @returns {{ title, channelTitle, publishedAt, viewCount, tags, thumbnailUrl }}
 */
export async function fetchVideoMetadata(videoId, authToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", videoId);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!response.ok) {
    throw new Error(`YouTube API 오류: ${response.status}`);
  }

  const data = await response.json();
  const item = data.items?.[0];
  if (!item) {
    throw new Error("동영상 정보를 찾을 수 없습니다.");
  }

  const snippet = item.snippet || {};
  const statistics = item.statistics || {};

  const thumbnailUrl = await resolveThumbnailUrl(videoId, snippet.thumbnails);

  return {
    title: snippet.title || "",
    channelTitle: snippet.channelTitle || "",
    publishedAt: snippet.publishedAt || "",
    viewCount: statistics.viewCount || "0",
    tags: snippet.tags || [],
    thumbnailUrl,
  };
}

/**
 * Try maxresdefault.jpg, fall back to hqdefault.jpg.
 */
async function resolveThumbnailUrl(videoId, thumbnails) {
  const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  try {
    const res = await fetch(maxres, { method: "HEAD" });
    if (res.ok) return maxres;
  } catch {
    // ignore
  }
  return (
    thumbnails?.high?.url ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  );
}
