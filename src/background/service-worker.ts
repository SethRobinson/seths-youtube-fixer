// Background service worker: owns the feedback cache + action log in
// chrome.storage.local. MV3 SWs are ephemeral — durable state lives in storage.
import {
  FEEDBACK_KEY,
  ACTIONLOG_KEY,
  emptyCache,
  isFresh,
  type FeedbackCache,
  type CaptureItem,
  type ActionLogEntry,
} from '../common/feedback';
import type { SyfMessage } from '../common/messages';

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SYF] installed:', details.reason);
});

async function loadCache(): Promise<FeedbackCache> {
  const o = await chrome.storage.local.get(FEEDBACK_KEY);
  return (o[FEEDBACK_KEY] as FeedbackCache) ?? emptyCache();
}
async function loadLog(): Promise<ActionLogEntry[]> {
  const o = await chrome.storage.local.get(ACTIONLOG_KEY);
  return (o[ACTIONLOG_KEY] as ActionLogEntry[]) ?? [];
}

// Serialize storage writes so concurrent messages don't clobber each other.
let writeChain: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(fn).catch((e) => console.error('[SYF] storage op failed', e));
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
      v.notInterested = {
        token: it.notInterestedToken,
        undoToken: it.notInterestedUndoToken,
        capturedAt: now,
        sourcePage: it.sourcePage,
      };
      changed = true;
    }
    if (it.dontRecommendChannelToken) {
      v.dontRecommendChannel = {
        token: it.dontRecommendChannelToken,
        undoToken: it.dontRecommendChannelUndoToken,
        capturedAt: now,
        sourcePage: it.sourcePage,
      };
      if (it.channelId) {
        const c = (cache.channels[it.channelId] ??= { channelId: it.channelId, updatedAt: now });
        if (it.channelName) c.channelName = it.channelName;
        c.dontRecommendChannel = {
          token: it.dontRecommendChannelToken,
          undoToken: it.dontRecommendChannelUndoToken,
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

chrome.runtime.onMessage.addListener((msg: SyfMessage, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'SYF_PING':
      sendResponse({ ok: true, ts: Date.now() });
      return false;

    case 'SYF_INJECTED':
      sendResponse({ ok: true });
      return false;

    case 'SYF_CAPTURE':
      enqueue(async () => {
        const cache = await loadCache();
        if (mergeCapture(cache, msg.items)) await chrome.storage.local.set({ [FEEDBACK_KEY]: cache });
      });
      sendResponse({ ok: true });
      return false;

    case 'SYF_LOOKUP':
      Promise.all([loadCache(), loadLog()]).then(([c, log]) => {
        const v = c.videos[msg.videoId];
        const ch = msg.channelId ? c.channels[msg.channelId] : undefined;
        const hateEntry =
          ch && isFresh(ch.dontRecommendChannel)
            ? ch.dontRecommendChannel
            : v && isFresh(v.dontRecommendChannel)
              ? v.dontRecommendChannel
              : undefined;
        const nahA = log.find((e) => !e.undone && e.type === 'notInterested' && e.videoId === msg.videoId);
        const hateA = log.find(
          (e) =>
            !e.undone &&
            e.type === 'dontRecommendChannel' &&
            ((msg.channelId && e.channelId === msg.channelId) || e.videoId === msg.videoId)
        );
        sendResponse({
          ok: true,
          nah: !!(v && isFresh(v.notInterested)),
          hate: !!hateEntry,
          videoKnown: !!v,
          nahToken: v && isFresh(v.notInterested) ? v.notInterested!.token : undefined,
          nahUndoToken: v?.notInterested?.undoToken,
          hateToken: hateEntry?.token,
          hateUndoToken: hateEntry?.undoToken,
          nahActive: nahA ? { id: nahA.id, undoToken: nahA.undoToken } : undefined,
          hateActive: hateA ? { id: hateA.id, undoToken: hateA.undoToken } : undefined,
        });
      });
      return true;

    case 'SYF_LOG_ACTION': {
      const id = crypto.randomUUID();
      const entry: ActionLogEntry = { ...msg.entry, id, ts: Date.now(), undone: false };
      enqueue(async () => {
        const log = await loadLog();
        log.unshift(entry);
        await chrome.storage.local.set({ [ACTIONLOG_KEY]: log.slice(0, 1000) });
      });
      sendResponse({ ok: true, id });
      return false;
    }

    case 'SYF_MARK_UNDONE':
      enqueue(async () => {
        const log = await loadLog();
        const target = msg.id
          ? log.find((e) => e.id === msg.id)
          : log.find(
              (e) =>
                !e.undone &&
                e.type === msg.match?.type &&
                (msg.match?.videoId ? e.videoId === msg.match.videoId : true) &&
                (msg.match?.channelId ? e.channelId === msg.match.channelId : true)
            );
        if (target && !target.undone) {
          target.undone = true;
          target.undoneAt = Date.now();
          await chrome.storage.local.set({ [ACTIONLOG_KEY]: log });
        }
      });
      sendResponse({ ok: true });
      return false;

    case 'SYF_GET_LOG':
      loadLog().then((log) => sendResponse({ ok: true, log }));
      return true;

    case 'SYF_STATS':
      loadCache().then((c) => sendResponse({ ok: true, stats: c.stats }));
      return true;

    default:
      return false;
  }
});
