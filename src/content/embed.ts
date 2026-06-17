// Runs in ALL youtube.com frames, but only acts inside OUR bottom-pane iframe —
// identified by window.name === 'syf-embed' (set on the <iframe name> in the
// comment-search window). There it:
//   1. Mutes (and briefly pauses) the watch video so the page we opened just to
//      read/Like/Reply a comment doesn't blast audio over the main window.
//   2. Drives the scroll to the linked (&lc=) comment: comments lazy-load on
//      scroll, and nothing scrolls inside an iframe, so YouTube's own "&lc="
//      auto-scroll never fires. We scroll #comments into view to trigger the load,
//      then center the highlighted/linked comment. Stops as soon as it's revealed
//      so we never fight the user's own scrolling.
if (window.top !== window.self && window.name === 'syf-embed') {
  const hasLc = /[?&]lc=/.test(location.search);
  let ticks = 0;
  let revealed = false;

  const tick = (): void => {
    const v = document.querySelector('video') as HTMLVideoElement | null;
    if (v) {
      v.muted = true;
      if (ticks < 6) {
        try {
          v.pause();
        } catch {
          /* noop */
        }
      }
    }

    if (hasLc && !revealed) {
      const comments = document.querySelector('#comments') as HTMLElement | null;
      // YouTube marks the &lc= deep-linked comment with a `linked` attribute on the
      // ytd-comment-view-model (the one shown under the "Highlighted comment/reply" header).
      // (`[highlighted]` is an older marker, kept as a fallback.)
      const linked = document.querySelector(
        'ytd-comment-view-model[linked], ytd-comment-thread-renderer[linked], #comments [highlighted]'
      ) as HTMLElement | null;
      if (linked) {
        linked.scrollIntoView({ block: 'center' });
        revealed = true; // found and centered the exact comment — done
      } else if (comments) {
        // Keep nudging #comments into view (triggers its lazy-load) AND keep polling for the
        // highlighted comment: it renders a beat after the first threads do, and when the video
        // has a separate pinned comment that one sits at the very top — so stopping at "threads
        // exist" would leave us showing the pinned comment, not the one the user clicked.
        comments.scrollIntoView({ block: 'start' });
        // Fallback: if the highlight marker never appears (~5s), at least leave the section shown.
        if (comments.querySelector('ytd-comment-thread-renderer') && ticks >= 12) revealed = true;
      }
    }
  };

  const iv = setInterval(() => {
    tick();
    if (++ticks > 30) clearInterval(iv); // ~12s
  }, 400);
  // Each comment click reloads the frame; re-arm for the new page.
  document.addEventListener('yt-navigate-finish', () => {
    ticks = 0;
    revealed = false;
  });
  tick();
}
