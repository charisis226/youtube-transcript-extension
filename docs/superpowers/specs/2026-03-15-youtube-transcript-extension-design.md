# YouTube Transcript → Google Docs Chrome Extension — Design Spec

**Date:** 2026-03-15
**Status:** Approved

---

## Overview

A Chrome Extension (Manifest V3) that extracts transcripts from YouTube videos and appends them to a user-specified Google Docs document. Supports optional Gemini AI summarization and timeline inclusion. The UI is presented as a Chrome Side Panel alongside the YouTube page.

---

## Goals

- Extract YouTube video transcripts via the YouTube timedtext API (no DOM scraping)
- Save transcripts to Google Docs with rich formatting (title, channel, thumbnail, tags, views, publish date, transcript, optional summary)
- Append each new video as a new section (not overwrite) in the target document
- Optional: include timestamps in transcript
- Optional: Gemini API summarization in user-selected language
- Optional: Gemini Vision description of thumbnail
- Thumbnail saved as inline image in Docs + optional Gemini Vision text description

---

## Non-Goals

- Does not support non-YouTube video pages
- Does not create new Google Docs (user provides existing Doc ID)
- Does not support batch processing of multiple videos at once
- Does not publish to Chrome Web Store automatically

---

## Architecture

### Approach: MV3 + Service Worker (centralized API calls)

All API calls (YouTube timedtext, YouTube Data API, Google Docs API, Gemini API) are handled by the **Service Worker**. The Side Panel handles UI only and communicates with the Service Worker via `chrome.runtime.sendMessage`.

### Data Flow

```
[YouTube Page]
    ↓  content script → chrome.runtime.sendMessage to service worker
      (videoId, title, channel cached in chrome.storage.session)
[Side Panel opens]
    ↓  sends GET_CURRENT_VIDEO to service worker → receives cached video info
[User clicks "Save"]
    ↓  sends SAVE_TRANSCRIPT to service worker
[Service Worker]
    ├── YouTube timedtext API  → raw transcript + timestamps
    ├── YouTube Data API v3    → title, channel, views, tags, publishedAt, thumbnail URL
    ├── Gemini API (optional)  → summary (user-selected language)
    ├── Gemini Vision (optional) → thumbnail description (base64 image)
    └── Google Docs API        → batchUpdate: append section using endOfSegmentLocation
```

---

## File Structure

```
youtube-transcript-extension/
├── manifest.json
├── background/
│   └── service-worker.js       # OAuth token mgmt, message routing, API orchestration
├── sidepanel/
│   ├── index.html
│   ├── panel.js                # UI logic, message passing
│   └── panel.css
├── content/
│   └── youtube.js              # Extracts videoId, sends to service worker via sendMessage
├── lib/
│   ├── youtube-api.js          # timedtext fetch + YouTube Data API calls
│   ├── docs-api.js             # Google Docs batchUpdate helpers
│   └── gemini-api.js           # Gemini text summarization + Vision thumbnail description
├── icons/
│   └── icon16.png / icon32.png / icon48.png / icon128.png
└── README.md                   # Setup guide (Google Cloud Console, OAuth, Doc ID)
```

---

## Component Details

### `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "YouTube Transcript to Docs",
  "version": "1.0.0",
  "permissions": ["identity", "storage", "sidePanel", "activeTab", "scripting"],
  "host_permissions": [
    "https://www.googleapis.com/*",
    "https://www.youtube.com/*",
    "https://generativelanguage.googleapis.com/*"
  ],
  "oauth2": {
    "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "scopes": [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/youtube.readonly"
    ]
  },
  "background": { "service_worker": "background/service-worker.js" },
  "side_panel": { "default_path": "sidepanel/index.html" },
  "content_scripts": [{
    "matches": ["https://www.youtube.com/watch*"],
    "js": ["content/youtube.js"]
  }],
  "action": { "default_title": "YouTube Transcript to Docs" }
}
```

### `content/youtube.js`

- Runs on `youtube.com/watch*` pages
- Extracts `videoId` from URL, page title, channel name from DOM
- Sends `{ type: "VIDEO_CHANGED", videoId, title, channelTitle }` to service worker via `chrome.runtime.sendMessage`
- Re-fires on YouTube SPA navigation by listening to the `yt-navigate-finish` DOM event
- Does NOT send directly to Side Panel (panel may not be open)

### `background/service-worker.js`

**State:**
- Caches current video info in `chrome.storage.session` (cleared on browser close): `{ videoId, title, channelTitle }`
- On `chrome.runtime.onInstalled` with `reason === "install"`: sets `firstRun: true` in `chrome.storage.local`, then opens Side Panel via `chrome.windows.getAll({ populate: false })` to get the current windowId, then calls `chrome.sidePanel.open({ windowId })`

**Message handlers:**
- `VIDEO_CHANGED` (from content script) → saves to `chrome.storage.session`
- `GET_CURRENT_VIDEO` (from side panel on open) → returns cached video from `chrome.storage.session`
- `GET_AUTH_TOKEN` → calls `chrome.identity.getAuthToken({ interactive: true })`
- `SAVE_TRANSCRIPT` → orchestrates full save pipeline:
  1. Fetch transcript via `youtube-api.js`
  2. Fetch video metadata via YouTube Data API
  3. (Optional) Fetch thumbnail as base64, call Gemini Vision
  4. (Optional) Call Gemini for text summary
  5. Append to Google Docs via `docs-api.js` using `endOfSegmentLocation`
  6. Save to local history in `chrome.storage.local`
  7. Send progress updates back to Side Panel via `chrome.runtime.sendMessage` — wrapped in try/catch since the Side Panel may be closed; failed sends are silently ignored
- `GET_HISTORY` → returns saved history from `chrome.storage.local`

### `lib/youtube-api.js`

**Transcript extraction flow:**
1. The content script is declared in `manifest.json` with `"world": "MAIN"` so it runs in the page's main JavaScript context and can directly read `window.ytInitialPlayerResponse`. It extracts the caption tracks array and sends the full player response data to the service worker via `chrome.runtime.sendMessage`.
2. Parse `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks` to get available caption tracks.
3. Track selection priority: manual captions > auto-generated; prefer page language, fallback to first available track.
4. Fetch the timedtext URL from the selected track object (already contains the full URL with auth params).
5. Parse the XML response into `[{ start: number, dur: number, text: string }]`.

**Metadata:**
- `fetchVideoMetadata(videoId, authToken)` → YouTube Data API v3 `videos.list` with `part=snippet,statistics`
- Returns: `{ title, channelTitle, publishedAt, viewCount, tags[], thumbnailUrl }`
- Thumbnail URL: use `maxresdefault.jpg` first; if 404, fallback to `hqdefault.jpg`:
  - `https://img.youtube.com/vi/{videoId}/maxresdefault.jpg`
  - `https://img.youtube.com/vi/{videoId}/hqdefault.jpg`

### `lib/docs-api.js`

- `appendVideoSection(docId, authToken, payload)` — builds `batchUpdate` requests
- All text insertions and image insertions use `endOfSegmentLocation: {}` to target document end — no manual index tracking needed
- Request order within the batch:
  1. `insertText` — page separator (`\n` + underscores)
  2. `insertText` + `updateParagraphStyle` — Heading 1 (video title)
  3. `insertText` + `updateParagraphStyle` — Heading 2 + metadata lines
  4. `insertInlineImage` with `uri` field — thumbnail image (public YouTube URL, width: 480pt, height: 270pt); followed immediately by a separate `insertText` request for `\n` to ensure subsequent content starts on a new paragraph (image insertion lands before the final newline; without this, next text merges onto the image's paragraph). Note: if Google's servers cannot fetch the thumbnail URI (network error, CDN issue), the Docs API returns an HTTP error for the entire batchUpdate — catch this specifically and retry without the image insertion step, logging a warning to the user
  5. `insertText` + `updateParagraphStyle` — Heading 2 + thumbnail description (if Gemini key present)
  6. `insertText` + `updateParagraphStyle` — Heading 2 + summary text (if Gemini key present)
  7. `insertText` + `updateParagraphStyle` — Heading 2 + transcript lines
- History `docsUrl` stored as document-level link: `https://docs.google.com/document/d/{docId}/edit` (per-section deep links not supported by Docs API)

### `lib/gemini-api.js`

- `summarize(transcript, language, apiKey)`:
  - Calls `gemini-1.5-flash` `generateContent` endpoint
  - Prompt: `"다음 YouTube 영상 스크립트를 {language}로 요약해주세요:\n\n{transcript}"`

- `describeThumbnail(thumbnailUrl, apiKey)`:
  - First fetches thumbnail as binary blob via `fetch(thumbnailUrl)`
  - Converts to base64 string
  - Calls Gemini Vision with:
    ```json
    {
      "parts": [
        { "inlineData": { "mimeType": "image/jpeg", "data": "<base64>" } },
        { "text": "이 YouTube 영상 썸네일 이미지를 한국어로 설명해주세요." }
      ]
    }
    ```

### `sidepanel/panel.js`

**On open:**
1. Reads `firstRun` from `chrome.storage.local` — if true, show Settings tab and clear flag
2. Sends `GET_CURRENT_VIDEO` to service worker to hydrate current video state
3. Listens for `VIDEO_CHANGED` messages from service worker for SPA navigation updates

**Three tabs: Save / Settings / History**

**Save Tab:**
- Displays current video info (thumbnail preview, title, channel, duration)
- Checkboxes: "타임라인 포함" (default from settings), "Gemini 요약 포함" (only shown if Gemini key configured)
- Dropdown: 요약 언어 (한국어, English, 日本語, 中文, Español — default from settings)
- Target Doc ID display (read from settings)
- "Google Docs에 저장" button (disabled if: not on YouTube watch page, no transcript, no Doc ID set, not logged in)
- Step-by-step progress indicator showing:
  - ✅/⏳/○ 자막 추출 / Gemini 요약 / Docs 저장
- Error states:
  - Not on YouTube watch page: "유튜브 영상 페이지에서 사용해주세요"
  - No transcript: "이 영상에는 자막이 없습니다"
  - No Doc ID: "설정에서 Google Doc ID를 입력해주세요"

**Settings Tab:**
- Google account login/logout button (shows logged-in email when authenticated)
- Google Doc ID input field
- Gemini API Key input (password field, optional)
- Default summary language selector
- Default timeline toggle

**History Tab:**
- Local history (last 20 entries, from `chrome.storage.local`)
- Each entry: thumbnail, title, channel, date saved, "문서 열기" link to `docsUrl`
- Deduplication: if the same `videoId` is saved again, the existing entry is updated (savedAt refreshed, moved to top) rather than creating a duplicate
- Cap enforcement: after adding a new entry, if `history.length > 20`, remove the oldest entry (FIFO by `savedAt`)

---

## Google Docs Output Format

Each video appended as:

```
\n___________________________________\n

[Heading 1] 영상 제목

[Heading 2] 📋 영상 정보
채널: 채널명
게시일: 2024-01-15
조회수: 1,234,567회
URL: https://youtube.com/watch?v=xxxxx
태그: #tag1 #tag2 #tag3

[Inline Image: 480×270pt] 썸네일

[Heading 2] 🖼️ 썸네일 설명  ← Gemini key 있을 때만
썸네일 이미지 설명 텍스트...

[Heading 2] ✨ 요약  ← Gemini key 있을 때만
요약 텍스트

[Heading 2] 📝 스크립트
[00:00] 첫 번째 자막 라인...    ← 타임라인 ON
[00:15] 두 번째 자막 라인...
(또는 타임라인 OFF: 연속 텍스트, 줄바꿈 없음)
```

---

## Settings Storage (`chrome.storage.local`)

```json
{
  "docId": "string",
  "geminiApiKey": "string (optional, stored in plaintext — see Security note)",
  "defaultIncludeTimeline": true,
  "defaultIncludeSummary": false,
  "defaultSummaryLanguage": "한국어",
  "firstRun": false,
  "history": [
    {
      "videoId": "string",
      "title": "string",
      "channelTitle": "string",
      "thumbnailUrl": "string",
      "savedAt": "ISO8601 string",
      "docsUrl": "https://docs.google.com/document/d/{docId}/edit"
    }
  ]
}
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Not on YouTube watch page | Side panel shows "유튜브 영상 페이지에서 사용해주세요" |
| Video has no transcript | Warning shown, Save button disabled |
| OAuth token expired | Auto-refresh via `chrome.identity.getAuthToken({interactive: false})`, prompt re-login if fails |
| Invalid Doc ID | Show error after first API call attempt |
| Gemini API key invalid/missing | Skip summary and thumbnail description, continue saving without them; show warning |
| Thumbnail maxresdefault 404 | Fallback to hqdefault.jpg; if both fail, skip inline image silently |
| Google Docs API fails to fetch thumbnail URI | Retry batchUpdate without `insertInlineImage` request; show "썸네일 삽입 실패" warning |
| Network error | Show which step failed (transcript/Gemini/Docs), allow retry |

---

## First-Run Flow

1. `chrome.runtime.onInstalled` fires with `reason === "install"`
2. Service worker sets `firstRun: true` in `chrome.storage.local`
3. Service worker attempts `chrome.windows.getAll()` + `chrome.sidePanel.open({ windowId })`. **Note:** `chrome.sidePanel.open()` requires a user gesture in Chrome and will silently fail when called from `onInstalled` (no gesture). As a reliable fallback, set a badge on the extension icon via `chrome.action.setBadgeText({ text: "NEW" })` and `chrome.action.setBadgeBackgroundColor({ color: "#FF0000" })` to prompt the user to click the icon and open the panel manually.
4. Side Panel `panel.js` reads `firstRun` on load → shows Settings tab, clears `firstRun` flag, clears badge via `chrome.action.setBadgeText({ text: "" })`
5. User completes: login → Doc ID → (optional) Gemini key → redirected to Save tab

---

## README Guide Outline

- Prerequisites: Chrome 114+, Google Cloud Console project
- Step 1: Create OAuth 2.0 Client ID (Chrome Extension type), add extension ID
- Step 2: Enable APIs: Google Docs API, YouTube Data API v3
- Step 3: Set `client_id` in `manifest.json`
- Step 4: Load unpacked extension in Chrome (`chrome://extensions` → "Load unpacked")
- Step 5: Create or open a Google Doc, copy Doc ID from URL
- Step 6: (Optional) Get Gemini API key from Google AI Studio

---

## Constraints & Notes

- Chrome 114+ required for Side Panel API (`chrome.sidePanel`)
- `chrome.storage.session` used for transient video state (cleared on browser close); requires `"storage"` permission. Service worker suspension does not affect this data — `chrome.storage.session` persists across service worker restarts within a browser session, unlike in-memory variables
- YouTube timedtext API endpoint is read from `ytInitialPlayerResponse`; no hardcoded URLs
- Google Docs `insertInlineImage` uses `uri` field with publicly accessible YouTube thumbnail URL; `objectSize` must be specified (480×270pt)
- Gemini Vision requires base64-encoded image data (`inlineData`), not a remote URL
- Per-section deep links in Google Docs are not supported by the Docs API; history entries link to the document root
- **Security:** The Gemini API key is stored in plaintext in `chrome.storage.local`. This is acceptable for personal/unpacked use. For Chrome Web Store distribution, consider using `chrome.storage.session` (in-memory, cleared on browser restart) or prompting the user to re-enter the key per session.
- Service Worker may be suspended by Chrome; all persistent state is in `chrome.storage.local`/`chrome.storage.session`
