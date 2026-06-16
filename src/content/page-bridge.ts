// Runs in the page's MAIN world (real page JS context). No chrome.* APIs here.
// Its job is to read YouTube page internals (ytInitialData, ytcfg, player
// response, Polymer element data) and to perform same-session feedback POSTs,
// communicating with the isolated content script via window.postMessage.
//
// For now it just announces readiness; feature wiring lands with the Nah /
// Hate-this-channel features.

const SOURCE = 'SYF_BRIDGE';

function announce() {
  const w = window as unknown as Record<string, unknown>;
  window.postMessage(
    {
      source: SOURCE,
      type: 'BRIDGE_READY',
      hasInitialData: 'ytInitialData' in w,
      hasCfg: 'ytcfg' in w,
    },
    location.origin
  );
}

// ytInitialData may not exist at document_start; announce now and again after
// the SPA hydrates so the content script can confirm the bridge is live.
announce();
window.addEventListener('yt-navigate-finish', announce);
