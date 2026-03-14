// lib/gemini-api.js
// Gemini AI functions for summarization and thumbnail description

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const FLASH_MODEL = "gemini-1.5-flash";

/**
 * Summarize a YouTube transcript using Gemini.
 * @param {string} transcript
 * @param {string} language - e.g. "한국어", "English"
 * @param {string} apiKey
 * @returns {string} summary text
 */
export async function summarize(transcript, language, apiKey) {
  const prompt = `다음 YouTube 영상 스크립트를 ${language}로 요약해주세요:\n\n${transcript}`;

  const response = await callGemini(apiKey, {
    contents: [{ parts: [{ text: prompt }] }],
  });

  return extractText(response);
}

/**
 * Describe a YouTube thumbnail image using Gemini Vision.
 * @param {string} thumbnailUrl
 * @param {string} apiKey
 * @returns {string} description text
 */
export async function describeThumbnail(thumbnailUrl, apiKey) {
  // Fetch image and convert to base64
  const imageResponse = await fetch(thumbnailUrl);
  if (!imageResponse.ok) {
    throw new Error(`썸네일 이미지 fetch 실패: ${imageResponse.status}`);
  }
  const blob = await imageResponse.blob();
  const base64 = await blobToBase64(blob);
  const mimeType = blob.type || "image/jpeg";

  const response = await callGemini(apiKey, {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType,
              data: base64,
            },
          },
          {
            text: "이 YouTube 영상 썸네일 이미지를 한국어로 설명해주세요.",
          },
        ],
      },
    ],
  });

  return extractText(response);
}

async function callGemini(apiKey, body) {
  const url = `${GEMINI_BASE}/${FLASH_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API 오류: ${response.status} — ${err}`);
  }

  return response.json();
}

function extractText(data) {
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // result is "data:image/jpeg;base64,<data>"
      const base64 = reader.result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
