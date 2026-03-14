// lib/docs-api.js
// Appends a YouTube video section to a Google Doc via batchUpdate

const DOCS_API = "https://docs.googleapis.com/v1/documents";

/**
 * Append a full video section to the end of a Google Doc.
 * @param {string} docId
 * @param {string} authToken
 * @param {object} payload
 */
export async function appendVideoSection(docId, authToken, payload) {
  const {
    videoId,
    title,
    channelTitle,
    metadata,
    transcript,
    thumbnailDescription,
    summary,
  } = payload;

  const publishedDate = metadata.publishedAt
    ? new Date(metadata.publishedAt).toLocaleDateString("ko-KR")
    : "알 수 없음";
  const viewCount = Number(metadata.viewCount).toLocaleString("ko-KR");
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const tagsText = metadata.tags?.length ? metadata.tags.slice(0, 10).join(", ") : "없음";

  const metadataText =
    `채널: ${metadata.channelTitle || channelTitle}\n` +
    `게시일: ${publishedDate}\n` +
    `조회수: ${viewCount}\n` +
    `URL: ${videoUrl}\n` +
    `태그: ${tagsText}`;

  const requests = [];

  // Helper: insert text at end of segment
  const ins = (text) => ({
    insertText: { text, location: { segmentId: "", index: 0 } },
  });
  // We'll build using endOfSegmentLocation for simplicity
  const insEnd = (text) => ({
    insertText: { text, endOfSegmentLocation: { segmentId: "" } },
  });

  // 1. Separator
  requests.push(insEnd("\n" + "─".repeat(60) + "\n"));

  // 2. Heading 1 – video title
  // We'll insert the title, then apply heading style via a named range trick.
  // Since index calculation is complex, we use a two-pass approach:
  // Insert all text first, then apply styles by tracking positions.
  // For simplicity here, we use paragraph style on the paragraph containing the title.

  // Because batchUpdate applies requests sequentially and indices shift,
  // the cleanest approach is to build a flat text blob with newlines, then
  // apply paragraph styles by scanning the resulting doc. However, the
  // recommended pattern for extensions is to insert styled paragraphs one
  // at a time using endOfSegmentLocation with paragraph style in the same request.
  //
  // We use insertText + updateParagraphStyle pairs, tracking that each
  // insertText at endOfSegmentLocation places the cursor, and the very next
  // updateParagraphStyle targets the last paragraph.

  requests.push({
    insertText: {
      text: title + "\n",
      endOfSegmentLocation: { segmentId: "" },
    },
  });
  // Note: paragraph style updates require knowing the range, which requires
  // a separate read. For a single-pass approach we use named styles via
  // a dedicated helper below that uses two API calls.

  // We'll take a simpler approach: build all inserts, then do a second
  // batchUpdate to apply heading styles. But to keep it one round-trip,
  // we structure the content with clear text markers and rely on the
  // appendWithStyles helper below.

  // Reset and use the two-call strategy.
  await appendWithStyles(docId, authToken, {
    title,
    metadataText,
    thumbnailUrl: metadata.thumbnailUrl,
    thumbnailDescription,
    summary,
    transcript,
  });
}

/**
 * Two-call strategy:
 * 1. Read the doc to get current end index.
 * 2. Build all insertText + style requests with absolute indices.
 */
async function appendWithStyles(docId, authToken, sections) {
  const { title, metadataText, thumbnailUrl, thumbnailDescription, summary, transcript } = sections;

  // Get current doc end index
  const docRes = await fetch(`${DOCS_API}/${docId}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!docRes.ok) {
    throw new Error(`Google Docs 읽기 실패: ${docRes.status}`);
  }
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.at(-1)?.endIndex ?? 1;

  // We'll insert at endIndex - 1 (before the final newline that Docs always keeps)
  let cursor = endIndex - 1;
  const requests = [];

  function addText(text) {
    requests.push({
      insertText: {
        text,
        location: { segmentId: "", index: cursor },
      },
    });
    cursor += text.length;
  }

  function applyHeading(start, end, headingId) {
    requests.push({
      updateParagraphStyle: {
        range: { segmentId: "", startIndex: start, endIndex: end },
        paragraphStyle: { namedStyleType: headingId },
        fields: "namedStyleType",
      },
    });
  }

  function applyNormal(start, end) {
    requests.push({
      updateParagraphStyle: {
        range: { segmentId: "", startIndex: start, endIndex: end },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
  }

  // Separator
  const sepText = "\n" + "─".repeat(60) + "\n";
  addText(sepText);

  // Heading 1: title
  const h1Start = cursor;
  addText(title + "\n");
  const h1End = cursor;
  applyHeading(h1Start, h1End, "HEADING_1");

  // Heading 2: 영상 정보
  const h2InfoStart = cursor;
  addText("📋 영상 정보\n");
  const h2InfoEnd = cursor;
  applyHeading(h2InfoStart, h2InfoEnd, "HEADING_2");

  // Metadata body
  const metaStart = cursor;
  addText(metadataText + "\n");
  applyNormal(metaStart, cursor);

  // Thumbnail image
  if (thumbnailUrl) {
    try {
      requests.push({
        insertInlineImage: {
          uri: thumbnailUrl,
          location: { segmentId: "", index: cursor },
          objectSize: {
            width: { magnitude: 480, unit: "PT" },
            height: { magnitude: 270, unit: "PT" },
          },
        },
      });
      cursor += 1; // inline image counts as 1 character
      addText("\n");
    } catch {
      // Skip image on failure
    }
  }

  // Heading 2: 썸네일 설명 (if available)
  if (thumbnailDescription) {
    const h2ThumbStart = cursor;
    addText("🖼️ 썸네일 설명\n");
    applyHeading(h2ThumbStart, cursor, "HEADING_2");
    const thumbDescStart = cursor;
    addText(thumbnailDescription + "\n");
    applyNormal(thumbDescStart, cursor);
  }

  // Heading 2: 요약 (if available)
  if (summary) {
    const h2SumStart = cursor;
    addText("✨ 요약\n");
    applyHeading(h2SumStart, cursor, "HEADING_2");
    const sumStart = cursor;
    addText(summary + "\n");
    applyNormal(sumStart, cursor);
  }

  // Heading 2: 스크립트
  const h2ScriptStart = cursor;
  addText("📝 스크립트\n");
  applyHeading(h2ScriptStart, cursor, "HEADING_2");
  const scriptStart = cursor;
  addText(transcript + "\n");
  applyNormal(scriptStart, cursor);

  // Execute batchUpdate
  await batchUpdate(docId, authToken, requests);
}

async function batchUpdate(docId, authToken, requests) {
  const response = await fetch(`${DOCS_API}/${docId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Docs 저장 실패: ${response.status} — ${err}`);
  }
  return response.json();
}
