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
import { SETTINGS_KEY, DEFAULT_SETTINGS, type SyfMessage, type SyfSettings } from '../common/messages';

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
async function loadSettings(): Promise<SyfSettings> {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...((o[SETTINGS_KEY] as SyfSettings) ?? {}) };
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MA_URL = 'https://myactivity.google.com/product/youtube';

function waitTabComplete(tabId: number, timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeoutMs);
  });
}

async function sendToTab(tabId: number, message: SyfMessage, tries = 8): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      await delay(700); // content script may not be ready yet
    }
  }
  throw new Error('My Activity content script did not respond');
}

async function handleWipe(mode: 'scan' | 'delete', startMs: number, endMs: number): Promise<any> {
  let tabId: number | undefined;
  try {
    // Fresh tab so our content script is active. Delete runs focused (active) —
    // My Activity's confirm dialog is unreliable in a background tab.
    const tab = await chrome.tabs.create({ url: MA_URL, active: mode === 'delete' });
    tabId = tab.id!;
    await waitTabComplete(tabId);
    await delay(5000); // let the SPA render the activity list
    const maMsg: SyfMessage =
      mode === 'scan'
        ? { type: 'SYF_MA_SCAN', startMs, endMs }
        : { type: 'SYF_MA_DELETE', startMs, endMs };
    const res = await sendToTab(tabId, maMsg);
    return res ?? { ok: false, mode, matched: [], error: 'no response' };
  } catch (e) {
    return { ok: false, mode, matched: [], error: String(e) };
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* already gone */
      }
    }
  }
}

// Submit a feedback token by relaying to an open YouTube tab's bridge (used by
// the standalone log page, which has no page session of its own).
async function relayReplay(token: string): Promise<any> {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*'] });
  const tab = tabs.find((t) => t.id);
  if (!tab?.id) return { ok: false, error: 'no-youtube-tab' };
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'SYF_DO_REPLAY', token } as SyfMessage);
  } catch {
    return { ok: false, error: 'relay-failed' };
  }
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
      Promise.all([loadCache(), loadLog(), loadSettings()]).then(([c, log, settings]) => {
        const ttlMs = (settings.feedbackTtlDays ?? 7) * 86_400_000;
        const v = c.videos[msg.videoId];
        const ch = msg.channelId ? c.channels[msg.channelId] : undefined;
        const hateEntry =
          ch && isFresh(ch.dontRecommendChannel, ttlMs)
            ? ch.dontRecommendChannel
            : v && isFresh(v.dontRecommendChannel, ttlMs)
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
          nah: !!(v && isFresh(v.notInterested, ttlMs)),
          hate: !!hateEntry,
          videoKnown: !!v,
          nahToken: v && isFresh(v.notInterested, ttlMs) ? v.notInterested!.token : undefined,
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

    case 'SYF_WIPE':
      handleWipe(msg.mode, msg.startMs, msg.endMs).then(sendResponse);
      return true;

    case 'SYF_OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;

    case 'SYF_OPEN_PAGE':
      chrome.tabs.create({ url: chrome.runtime.getURL(msg.page === 'wipe' ? 'wipe/wipe.html' : 'log/log.html') });
      sendResponse({ ok: true });
      return false;

    case 'SYF_RELAY_REPLAY':
      relayReplay(msg.token).then(sendResponse);
      return true;

    case 'SYF_STATS':
      loadCache().then((c) => sendResponse({ ok: true, stats: c.stats }));
      return true;

    default:
      return false;
  }
});
