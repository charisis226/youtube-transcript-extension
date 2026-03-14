// content/youtube.js
// Runs in MAIN world to access window.ytInitialPlayerResponse
// Injected on https://www.youtube.com/watch* pages

(function () {
  function getVideoId() {
    return new URLSearchParams(window.location.search).get("v");
  }

  function getTitle() {
    return (
      document.querySelector("h1.ytd-video-primary-info-renderer")?.textContent?.trim() ||
      document.querySelector("h1.style-scope.ytd-watch-metadata")?.textContent?.trim() ||
      document.title.replace(" - YouTube", "").trim()
    );
  }

  function getChannelTitle() {
    return (
      document.querySelector("#channel-name #text")?.textContent?.trim() ||
      document.querySelector("ytd-channel-name #text")?.textContent?.trim() ||
      ""
    );
  }

  function getCaptionTracks() {
    try {
      const playerResponse = window.ytInitialPlayerResponse;
      if (!playerResponse) return [];
      return (
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
      );
    } catch {
      return [];
    }
  }

  function sendVideoInfo() {
    const videoId = getVideoId();
    if (!videoId) return;

    const title = getTitle();
    const channelTitle = getChannelTitle();
    const captionTracks = getCaptionTracks();

    chrome.runtime.sendMessage({
      type: "VIDEO_CHANGED",
      videoId,
      title,
      channelTitle,
      captionTracks,
    });
  }

  // Initial send on page load
  sendVideoInfo();

  // Handle YouTube SPA navigation
  window.addEventListener("yt-navigate-finish", () => {
    // Brief delay to let DOM and ytInitialPlayerResponse update
    setTimeout(sendVideoInfo, 500);
  });
})();
