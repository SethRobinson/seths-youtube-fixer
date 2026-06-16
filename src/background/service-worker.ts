// Background service worker: owns the feedback cache in chrome.storage.local.
// MV3 SWs are ephemeral — all durable state lives in storage; this just mediates.
import {
  FEEDBACK_KEY,
  emptyCache,
  isFresh,
  type FeedbackCache,
  type CaptureItem,
} from '../common/feedback';
import type { SyfMessage } from '../common/messages';

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SYF] installed:', details.reason);
});

async function loadCache(): Promise<FeedbackCache> {
  const o = await chrome.storage.local.get(FEEDBACK_KEY);
  return (o[FEEDBACK_KEY] as FeedbackCache) ?? emptyCache();
}

// Serialize read-modify-write so concurrent captures from multiple tabs don't clobber.
let writeChain: Promise<void> = Promise.resolve();
function withCache(fn: (c: FeedbackCache) => boolean): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      const cache = await loadCache();
      if (fn(cache)) await chrome.storage.local.set({ [FEEDBACK_KEY]: cache });
    })
    .catch((e) => console.error('[SYF] cache op failed', e));
  return writeChain;
}

function mergeCapture(cache: FeedbackCache, items: CaptureItem[]): boolean {
  let changed = false;
  const now = Date.now();
  for (const it of items) {
    if (!it.videoId) continue;
    cache.stats.capturesSeen++;
    const v = (cache.videos[it.videoId] ??= { videoId: it.videoId, updatedAt: now });
    if (it.title) v.title = it.title;
    if (it.channelId) v.channelId = it.channelId;
    if (it.channelName) v.channelName = it.channelName;
    if (it.notInterestedToken) {
      v.notInterested = { token: it.notInterestedToken, capturedAt: now, sourcePage: it.sourcePage };
      changed = true;
    }
    if (it.dontRecommendChannelToken) {
      v.dontRecommendChannel = {
        token: it.dontRecommendChannelToken,
        capturedAt: now,
        sourcePage: it.sourcePage,
      };
      if (it.channelId) {
        const c = (cache.channels[it.channelId] ??= { channelId: it.channelId, updatedAt: now });
        if (it.channelName) c.channelName = it.channelName;
        c.dontRecommendChannel = {
          token: it.dontRecommendChannelToken,
          capturedAt: now,
          sampleVideoId: it.videoId,
        };
        c.updatedAt = now;
      }
      changed = true;
    }
    v.updatedAt = now;
  }
  cache.stats.videosTracked = Object.keys(cache.videos).length;
  cache.stats.channelsTracked = Object.keys(cache.channels).length;
  if (changed) cache.stats.lastCaptureAt = now;
  return changed;
}

chrome.runtime.onMessage.addListener((msg: SyfMessage, sender, sendResponse) => {
  switch (msg?.type) {
    case 'SYF_PING':
      sendResponse({ ok: true, ts: Date.now() });
      return false;

    case 'SYF_INJECTED':
      sendResponse({ ok: true });
      return false;

    case 'SYF_CAPTURE':
      void withCache((c) => mergeCapture(c, msg.items));
      sendResponse({ ok: true });
      return false;

    case 'SYF_LOOKUP':
      loadCache().then((c) => {
        const v = c.videos[msg.videoId];
        const ch = msg.channelId ? c.channels[msg.channelId] : undefined;
        const nah = !!(v && isFresh(v.notInterested));
        const hate = !!((ch && isFresh(ch.dontRecommendChannel)) || (v && isFresh(v.dontRecommendChannel)));
        sendResponse({ ok: true, nah, hate, videoKnown: !!v });
      });
      return true; // async response

    case 'SYF_STATS':
      loadCache().then((c) => sendResponse({ ok: true, stats: c.stats }));
      return true;

    default:
      return false;
  }
});
