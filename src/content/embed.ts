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
      const linked = document.querySelector(
        'ytd-comment-thread-renderer[highlighted], ytd-comment-view-model[highlighted], #comments [highlighted]'
      ) as HTMLElement | null;
      if (linked) {
        linked.scrollIntoView({ block: 'center' });
        revealed = true; // found the exact comment — stop here
      } else if (comments && comments.querySelector('ytd-comment-thread-renderer')) {
        // Threads loaded but no explicit highlight marker — the linked comment is
        // pinned at the top of #comments, so showing the section reveals it.
        comments.scrollIntoView({ block: 'start' });
        revealed = true;
      } else if (comments) {
        comments.scrollIntoView({ block: 'start' }); // not loaded yet — nudge the lazy-load
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
