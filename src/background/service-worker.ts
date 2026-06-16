// Background service worker: owns the feedback cache + action log in
// chrome.storage.local. MV3 SWs are ephemeral — durable state lives in storage.
import {
  FEEDBACK_KEY,
  ACTIONLOG_KEY,
  DEFAULT_CACHE_CAP,
  MAX_FEEDBACK_BYTES,
  emptyCache,
  isFresh,
  type FeedbackCache,
  type CaptureItem,
  type ActionLogEntry,
} from '../common/feedback';
import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  ALL_STORAGE_KEYS,
  type SyfMessage,
  type SyfSettings,
  type HistoryResult,
} from '../common/messages';

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SYF] installed:', details.reason);
});

// MV3 SWs are ephemeral; flush any pending throttled cache write before suspension.
// Best-effort (async may not finish) — a lost write is ≤ one throttle window of
// re-capturable captures.
chrome.runtime.onSuspend.addListener(() => {
  void flushCache();
});

// In-memory copies so lookups (every navigation) don't re-parse storage. The SW
// is the only writer of the cache/log; mutations update these in place. Reset
// invalidates them. They reload once after the (ephemeral) SW restarts.
let cacheMem: FeedbackCache | null = null;
let logMem: ActionLogEntry[] | null = null;
let settingsMem: SyfSettings | null = null;
function invalidateMem(): void {
  cacheMem = logMem = settingsMem = null;
}

async function loadCache(): Promise<FeedbackCache> {
  if (cacheMem) return cacheMem;
  const o = await chrome.storage.local.get(FEEDBACK_KEY);
  cacheMem = (o[FEEDBACK_KEY] as FeedbackCache) ?? emptyCache();
  return cacheMem;
}
async function loadLog(): Promise<ActionLogEntry[]> {
  if (logMem) return logMem;
  const o = await chrome.storage.local.get(ACTIONLOG_KEY);
  logMem = (o[ACTIONLOG_KEY] as ActionLogEntry[]) ?? [];
  return logMem;
}
async function loadSettings(): Promise<SyfSettings> {
  if (settingsMem) return settingsMem;
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  settingsMem = { ...DEFAULT_SETTINGS, ...((o[SETTINGS_KEY] as SyfSettings) ?? {}) };
  return settingsMem;
}

// Serialize storage writes so concurrent messages don't clobber each other.
let writeChain: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(fn).catch((e) => console.error('[SYF] storage op failed', e));
  return writeChain;
}

// All settings mutations go through one serialized merge so concurrent writers
// (options page, history toggle, dismissed-warning) can't clobber each other.
function patchSettings(patch: Partial<SyfSettings>): Promise<void> {
  return enqueue(async () => {
    const s = await loadSettings();
    settingsMem = { ...s, ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settingsMem });
  });
}

// Keep the cache bounded (LRU by updatedAt) so it stays fast to load/save.
// Caps (MAX_VIDEOS / MAX_CHANNELS / MAX_FEEDBACK_BYTES) are shared via ../common/feedback.
function evictOldest(map: Record<string, { updatedAt: number }>, max: number): void {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort((a, b) => (map[a].updatedAt || 0) - (map[b].updatedAt || 0));
  for (const k of keys.slice(0, keys.length - max)) delete map[k];
}

function mergeCapture(cache: FeedbackCache, items: CaptureItem[], maxEntries: number): boolean {
  let changed = false;
  const now = Date.now();
  for (const it of items) {
    if (!it.videoId) continue;
    cache.stats.capturesSeen++;
    const v = (cache.videos[it.videoId] ??= { videoId: it.videoId, updatedAt: now });
    if (it.title) v.title = it.title;
    if (it.channelId) v.channelId = it.channelId;
    if (it.channelName) v.channelName = it.channelName;
    // Only flag `changed` (→ a write) when a token is genuinely new. Re-seeing an
    // already-cached token is the common case while browsing and must NOT trigger a write.
    if (it.notInterestedToken && it.notInterestedToken !== v.notInterested?.token) {
      v.notInterested = { token: it.notInterestedToken, undoToken: it.notInterestedUndoToken, capturedAt: now };
      changed = true;
    }
    if (it.dontRecommendChannelToken) {
      if (it.channelId) {
        const c = (cache.channels[it.channelId] ??= { channelId: it.channelId, updatedAt: now });
        if (it.channelName) c.channelName = it.channelName;
        if (it.dontRecommendChannelToken !== c.dontRecommendChannel?.token) {
          // Store channel-level only — don't duplicate the (long) token in the video entry too.
          c.dontRecommendChannel = {
            token: it.dontRecommendChannelToken,
            undoToken: it.dontRecommendChannelUndoToken,
            capturedAt: now,
            sampleVideoId: it.videoId,
          };
          c.updatedAt = now;
          changed = true;
        }
        if (v.dontRecommendChannel) {
          delete v.dontRecommendChannel;
          changed = true;
        }
      } else if (it.dontRecommendChannelToken !== v.dontRecommendChannel?.token) {
        // Fallback when we couldn't extract a channelId.
        v.dontRecommendChannel = {
          token: it.dontRecommendChannelToken,
          undoToken: it.dontRecommendChannelUndoToken,
          capturedAt: now,
        };
        changed = true;
      }
    }
    v.updatedAt = now;
  }
  evictOldest(cache.videos, maxEntries);
  evictOldest(cache.channels, maxEntries);
  cache.stats.videosTracked = Object.keys(cache.videos).length;
  cache.stats.channelsTracked = Object.keys(cache.channels).length;
  if (changed) cache.stats.lastCaptureAt = now;
  return changed;
}

// Writes are coalesced: captures mutate the in-memory cache and schedule a flush at
// most once per FLUSH_THROTTLE_MS, so a scroll burst (~160 videos) is one write, not
// 160. The in-memory cache is always current, so lookups never wait on a flush.
const FLUSH_THROTTLE_MS = 2_000;
let cacheDirty = false;
let lastFlushAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  cacheDirty = true;
  if (flushTimer) return;
  const wait = Math.max(0, FLUSH_THROTTLE_MS - (Date.now() - lastFlushAt));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void enqueue(flushCache);
  }, wait);
}

async function flushCache(): Promise<void> {
  if (!cacheDirty || !cacheMem) return;
  cacheDirty = false;
  lastFlushAt = Date.now();
  await chrome.storage.local.set({ [FEEDBACK_KEY]: cacheMem });
  // 50 MB byte backstop (≈never fires at the 10K entry cap / ~15 MB): if the stored
  // blob is over, evict the oldest entries in chunks and rewrite until it fits.
  let bytes = await chrome.storage.local.getBytesInUse(FEEDBACK_KEY).catch(() => 0);
  while (
    bytes > MAX_FEEDBACK_BYTES &&
    Object.keys(cacheMem.videos).length + Object.keys(cacheMem.channels).length > 0
  ) {
    console.warn('[SYF] feedback cache over 50 MB byte cap — evicting oldest');
    evictOldest(cacheMem.videos, Math.max(0, Object.keys(cacheMem.videos).length - 500));
    evictOldest(cacheMem.channels, Math.max(0, Object.keys(cacheMem.channels).length - 500));
    cacheMem.stats.videosTracked = Object.keys(cacheMem.videos).length;
    cacheMem.stats.channelsTracked = Object.keys(cacheMem.channels).length;
    await chrome.storage.local.set({ [FEEDBACK_KEY]: cacheMem });
    bytes = await chrome.storage.local.getBytesInUse(FEEDBACK_KEY).catch(() => 0);
  }
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

// Toggle/read watch-history pause state by driving /feed/history in a background
// tab (our content script there extracts the token and submits via the bridge).
async function handleHistory(action: 'toggle' | 'state'): Promise<HistoryResult> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: 'https://www.youtube.com/feed/history', active: false });
    tabId = tab.id!;
    await waitTabComplete(tabId);
    await delay(3800);
    const res = await sendToTab(tabId, { type: 'SYF_HISTORY_DO', action } as SyfMessage);
    return (res as HistoryResult) ?? { ok: false, error: 'no-response' };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* gone */
      }
    }
  }
}

chrome.runtime.onMessage.addListener((msg: SyfMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // ignore anything not from our own contexts
  switch (msg?.type) {
    case 'SYF_PING':
      sendResponse({ ok: true, ts: Date.now() });
      return false;

    case 'SYF_INJECTED':
      sendResponse({ ok: true });
      return false;

    case 'SYF_CAPTURE':
      enqueue(async () => {
        const [cache, settings] = await Promise.all([loadCache(), loadSettings()]);
        if (mergeCapture(cache, msg.items, settings.maxCacheVideos ?? DEFAULT_CACHE_CAP)) scheduleFlush();
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
        if (log.length > 1000) log.length = 1000;
        await chrome.storage.local.set({ [ACTIONLOG_KEY]: log });
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

    case 'SYF_OPEN_PAGE': {
      const q = msg.minutes ? `?minutes=${msg.minutes}` : '';
      chrome.tabs.create({ url: chrome.runtime.getURL('wipe/wipe.html') + q });
      sendResponse({ ok: true });
      return false;
    }

    case 'SYF_RELAY_REPLAY':
      relayReplay(msg.token).then(sendResponse);
      return true;

    case 'SYF_HISTORY':
      handleHistory(msg.action).then(async (res) => {
        if (res.ok && typeof res.paused === 'boolean') await patchSettings({ lastHistoryPaused: res.paused });
        sendResponse(res);
      });
      return true;

    case 'SYF_PATCH_SETTINGS': {
      const newCap = msg.patch.maxCacheVideos;
      patchSettings(msg.patch).then(async () => {
        // If the cache cap changed, shrink the cache now (not just on the next capture).
        if (typeof newCap === 'number') {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          await enqueue(async () => {
            const cache = await loadCache();
            evictOldest(cache.videos, newCap);
            evictOldest(cache.channels, newCap);
            cache.stats.videosTracked = Object.keys(cache.videos).length;
            cache.stats.channelsTracked = Object.keys(cache.channels).length;
            await chrome.storage.local.set({ [FEEDBACK_KEY]: cache });
            cacheDirty = false;
            lastFlushAt = Date.now();
          });
        }
        sendResponse({ ok: true });
      });
      return true;
    }

    case 'SYF_RESET':
      // Cancel any pending throttled flush so it can't resurrect data after the wipe.
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      cacheDirty = false;
      // Ordered after pending writes so an in-flight save can't resurrect data.
      enqueue(async () => {
        await chrome.storage.local.remove(ALL_STORAGE_KEYS);
        invalidateMem();
      }).then(() => sendResponse({ ok: true }));
      return true;

    case 'SYF_STATS':
      loadCache().then((c) => sendResponse({ ok: true, stats: c.stats }));
      return true;

    default:
      return false;
  }
});
