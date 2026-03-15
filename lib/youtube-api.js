// lib/youtube-api.js
// YouTube transcript extraction and video metadata

/**
 * Extract transcript using YouTube Innertube API (get_transcript).
 * Works from service worker without page cookies.
 * @param {string} videoId
 * @param {string} languageCode - e.g. "ko", "en"
 * @returns {Array<{start: number, text: string}>}
 */
async function fetchSegmentsFromInnertube(videoId, languageCode, innertubePost = null, transcriptParams = null) {
  // Use params from ytInitialData if available, otherwise encode from videoId
  const params = transcriptParams || encodeTranscriptParams(videoId);
  const body = {
    context: {
      client: { clientName: "WEB", clientVersion: "2.20231121.08.00", hl: languageCode || "ko" },
    },
    params,
  };

  let rawText = "";
  if (innertubePost) {
    // Use page context (has YouTube cookies)
    rawText = await innertubePost(body);
  } else {
    const response = await fetch("https://www.youtube.com/youtubei/v1/get_transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    rawText = await response.text();
  }

  if (!rawText) {
    return { segments: [], debug: "응답 비어있음" };
  }

  let data;
  try { data = JSON.parse(rawText); } catch {
    return { segments: [], debug: `JSON파싱실패 body:${rawText.slice(0, 200)}` };
  }

  const initialSegments =
    data?.actions?.[0]?.updateEngagementPanelAction?.content
      ?.transcriptRenderer?.content
      ?.transcriptSearchPanelRenderer?.body
      ?.transcriptSegmentsRenderer?.initialSegments ?? [];

  if (initialSegments.length === 0) {
    return { segments: [], debug: `initialSegments없음 keys:${Object.keys(data?.actions?.[0] ?? {}).join(",")} rawStart:${rawText.slice(0, 150)}` };
  }

  const segments = initialSegments
    .map((seg) => {
      const r = seg.transcriptSegmentRenderer;
      if (!r) return null;
      const text = r.snippet?.runs?.map((run) => run.text).join("") ?? "";
      const start = parseInt(r.startMs || "0", 10) / 1000;
      return { start, text };
    })
    .filter(Boolean);

  return { segments, debug: "ok" };
}

/**
 * Encode videoId into protobuf params for get_transcript API.
 */
function encodeTranscriptParams(videoId) {
  const enc = new TextEncoder();
  const vidBytes = enc.encode(videoId);

  // Inner message: { field 1 = videoId (string) }
  const inner = [0x0a, vidBytes.length, ...vidBytes];

  // Outer message: { field 1 = inner (bytes) }
  const outer = [0x0a, inner.length, ...inner];

  return btoa(String.fromCharCode(...outer));
}

/**
 * Extract transcript text from caption tracks.
 * @param {Array} captionTracks - from ytInitialPlayerResponse
 * @param {boolean} includeTimeline
 * @param {Function|null} fetchXml - legacy fetcher, kept as fallback
 */
export async function extractTranscript(captionTracks, includeTimeline = false, videoId = "") {
  if (!videoId) throw new Error("videoId가 없습니다.");

  const track = captionTracks?.length > 0 ? selectBestTrack(captionTracks) : null;
  const lang = track?.languageCode || "ko";

  const response = await fetch(
    `http://localhost:5000/transcript?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.status }));
    throw new Error(err.error || `서버 오류: ${response.status}`);
  }

  const { segments } = await response.json();

  if (!segments || segments.length === 0) {
    throw new Error("자막을 찾을 수 없습니다.");
  }

  if (includeTimeline) {
    return segments.map(({ start, text }) => `[${formatTime(start)}] ${text}`).join("\n");
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

  const manual = tracks.filter((t) => !t.kind || t.kind !== "asr");
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
 */
export async function fetchVideoMetadata(videoId, authToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", videoId);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (!response.ok) throw new Error(`YouTube API 오류: ${response.status}`);

  const data = await response.json();
  const item = data.items?.[0];
  if (!item) throw new Error("동영상 정보를 찾을 수 없습니다.");

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

async function resolveThumbnailUrl(videoId, thumbnails) {
  const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  try {
    const res = await fetch(maxres, { method: "HEAD" });
    if (res.ok) return maxres;
  } catch {
    // ignore
  }
  return thumbnails?.high?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
