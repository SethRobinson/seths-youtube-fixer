// Background service worker for Seth's YouTube Fixer.
// MV3 service workers are ephemeral: never hold state in module scope that must
// survive — persist to chrome.storage instead.
import type { SyfMessage, SyfResponse } from '../common/messages';

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SYF] installed:', details.reason);
});

chrome.runtime.onMessage.addListener(
  (msg: SyfMessage, sender, sendResponse: (r: SyfResponse) => void) => {
    switch (msg?.type) {
      case 'SYF_PING':
        sendResponse({ ok: true, ts: Date.now() });
        return false;
      case 'SYF_INJECTED':
        console.log('[SYF] bar injected on tab', sender.tab?.id, 'video', msg.videoId);
        sendResponse({ ok: true, ts: Date.now() });
        return false;
      default:
        return false;
    }
  }
);
