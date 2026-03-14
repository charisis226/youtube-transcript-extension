// lib/youtube-api.js
// YouTube transcript extraction and video metadata

/**
 * Extract transcript text from caption tracks.
 * @param {Array} captionTracks - from ytInitialPlayerResponse
 * @param {boolean} includeTimeline - whether to prefix lines with [MM:SS]
 * @returns {string} transcript text
 */
export async function extractTranscript(captionTracks, includeTimeline = false) {
  if (!captionTracks || captionTracks.length === 0) {
    throw new Error("자막을 찾을 수 없습니다.");
  }

  const track = selectBestTrack(captionTracks);
  const url = track.baseUrl;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`자막 fetch 실패: ${response.status}`);
  }

  const xml = await response.text();
  const segments = parseTimedText(xml);

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
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const textNodes = doc.querySelectorAll("text");

  return Array.from(textNodes).map((node) => ({
    start: parseFloat(node.getAttribute("start") || "0"),
    dur: parseFloat(node.getAttribute("dur") || "0"),
    text: decodeHTMLEntities(node.textContent),
  }));
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
