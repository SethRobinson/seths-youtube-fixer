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
  ACCOUNT_KEY,
  QUOTA_KEY,
  DEFAULT_DAILY_QUOTA,
  type SyfMessage,
  type SyfSettings,
  type HistoryResult,
  type CsComment,
  type CsThread,
  type CommentsPageResult,
  type RepliesPageResult,
  type QuotaResult,
} from '../common/messages';

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SYF] installed:', details.reason);
  void syncIframeRuleset();
});
chrome.runtime.onStartup.addListener(() => void syncIframeRuleset());

// The static ruleset `syf_iframe` (rules/iframe-rules.json) strips X-Frame-Options/CSP so
// the comment-search window can frame the real watch page. That's a powerful, global change,
// so it ships DISABLED and we enable it only while a comment-search window is actually open —
// shrinking the exposure window from "the whole time the extension is installed" to "while
// you're searching comments." We derive the desired state from whether any comments/search.html
// tab exists, so it self-heals across the ephemeral SW's restarts (the enabled-state persists).
const SEARCH_PAGE_PREFIX = chrome.runtime.getURL('comments/search.html');
async function setIframeRuleset(on: boolean): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      on ? { enableRulesetIds: ['syf_iframe'] } : { disableRulesetIds: ['syf_iframe'] }
    );
  } catch (e) {
    console.error('[SYF] setIframeRuleset failed', e);
  }
}
// Reconcile from ground truth: the rule should be enabled iff a comments/search.html tab is
// open. Used to turn it back OFF when the window closes and to self-heal on SW wake. (Enabling
// on open is done directly in the SYF_OPEN_COMMENT_SEARCH handler — relying on this to ENABLE
// would race the just-created tab before its URL is queryable.)
async function syncIframeRuleset(): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  await setIframeRuleset(tabs.some((t) => t.url?.startsWith(SEARCH_PAGE_PREFIX)));
}
chrome.windows.onRemoved.addListener(() => void syncIframeRuleset());
chrome.tabs.onRemoved.addListener(() => void syncIframeRuleset());
void syncIframeRuleset(); // reconcile whenever the SW wakes

// MV3 SWs are ephemeral; flush any pending throttled cache write before suspension.
// Best-effort (async may not finish) — a lost write is ≤ one throttle window of
// re-capturable captures.
chrome.runtime.onSuspend.addListener(() => {
  void flushCache();
  void flushQuota();
});

// In-memory copies so lookups (every navigation) don't re-parse storage. The SW
// is the only writer of the cache/log; mutations update these in place. Reset
// invalidates them. They reload once after the (ephemeral) SW restarts.
let cacheMem: FeedbackCache | null = null;
let logMem: ActionLogEntry[] | null = null;
let settingsMem: SyfSettings | null = null;
let quotaMem: { ptDate: string; used: number } | null = null;
function invalidateMem(): void {
  cacheMem = logMem = settingsMem = quotaMem = null;
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

// --- API quota estimate (local) ---------------------------------------------------------
// The Data API can't tell a key its remaining quota, so we count our own calls: each
// commentThreads.list / comments.list read costs 1 unit. Resets at midnight Pacific (like
// Google's quota), keyed by the Pacific calendar date. Writes are throttled/coalesced.
function ptDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}
async function loadQuota(): Promise<{ ptDate: string; used: number }> {
  if (!quotaMem) {
    const o = await chrome.storage.local.get(QUOTA_KEY);
    quotaMem = (o[QUOTA_KEY] as { ptDate: string; used: number }) ?? { ptDate: ptDate(), used: 0 };
  }
  const today = ptDate();
  if (quotaMem.ptDate !== today) quotaMem = { ptDate: today, used: 0 }; // new Pacific day → reset
  return quotaMem;
}
let quotaDirty = false;
let quotaFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleQuotaFlush(): void {
  quotaDirty = true;
  if (quotaFlushTimer) return;
  quotaFlushTimer = setTimeout(() => {
    quotaFlushTimer = null;
    void flushQuota();
  }, 2_000);
}
async function flushQuota(): Promise<void> {
  if (!quotaDirty || !quotaMem) return;
  quotaDirty = false;
  await chrome.storage.local.set({ [QUOTA_KEY]: quotaMem });
}
// Count API units (serialized so concurrent searches can't lose increments).
function bumpQuota(units = 1): Promise<void> {
  return enqueue(async () => {
    const q = await loadQuota();
    q.used += units;
    quotaMem = q;
    scheduleQuotaFlush();
  });
}
async function getQuotaState(): Promise<QuotaResult> {
  const [q, settings] = await Promise.all([loadQuota(), loadSettings()]);
  return { ok: true, used: q.used, limit: settings.apiDailyQuota ?? DEFAULT_DAILY_QUOTA, ptDate: q.ptDate };
}
function resetQuota(): Promise<void> {
  return enqueue(async () => {
    if (quotaFlushTimer) {
      clearTimeout(quotaFlushTimer);
      quotaFlushTimer = null;
    }
    quotaDirty = false;
    quotaMem = { ptDate: ptDate(), used: 0 };
    await chrome.storage.local.set({ [QUOTA_KEY]: quotaMem });
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
const HISTORY_URL = 'https://www.youtube.com/feed/history';

interface StoredAccount {
  id: string;
  authUser?: string;
  pageId?: string;
}

function normalizeAuthUser(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}
function normalizePageId(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}

function storedAccount(v: unknown): StoredAccount {
  if (typeof v === 'string') return { id: v };
  if (v && typeof v === 'object') {
    const o = v as { id?: unknown; accountId?: unknown; authUser?: unknown; pageId?: unknown };
    return {
      id: String(o.id ?? o.accountId ?? ''),
      authUser: normalizeAuthUser(o.authUser),
      pageId: normalizePageId(o.pageId),
    };
  }
  return { id: '' };
}

async function storedAccountRoute(): Promise<{ authUser: string; pageId: string }> {
  const o = await chrome.storage.local.get(ACCOUNT_KEY);
  const a = storedAccount(o[ACCOUNT_KEY]);
  return { authUser: a.authUser || '', pageId: a.pageId || '' };
}

async function resolveAccountRoute(authUser?: string, pageId?: string): Promise<{ authUser: string; pageId: string }> {
  const stored = await storedAccountRoute();
  return {
    authUser: normalizeAuthUser(authUser) || stored.authUser,
    pageId: normalizePageId(pageId) || stored.pageId,
  };
}

function accountUrl(url: string, authUser: string, pageId = ''): string {
  const base = pageId && url === MA_URL ? `https://myactivity.google.com/b/${pageId}/product/youtube` : url;
  const u = new URL(base);
  if (authUser) u.searchParams.set('authuser', authUser);
  if (pageId) u.searchParams.set('pageId', pageId);
  return u.href;
}

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

async function handleWipe(mode: 'scan' | 'delete', startMs: number, endMs: number, authUser?: string, pageId?: string): Promise<any> {
  let tabId: number | undefined;
  try {
    const route = await resolveAccountRoute(authUser, pageId);
    // Fresh tab so our content script is active. Delete runs focused (active) —
    // My Activity's confirm dialog is unreliable in a background tab.
    const tab = await chrome.tabs.create({ url: accountUrl(MA_URL, route.authUser, route.pageId), active: mode === 'delete' });
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
async function handleHistory(action: 'toggle' | 'state', authUser?: string, pageId?: string): Promise<HistoryResult> {
  let tabId: number | undefined;
  try {
    const route = await resolveAccountRoute(authUser, pageId);
    const tab = await chrome.tabs.create({ url: accountUrl(HISTORY_URL, route.authUser, route.pageId), active: false });
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

// --- Feature: Find in comments (YouTube Data API v3, read-only, with the user's key) ---
// The SW makes the googleapis.com calls (it has the host permission and full
// cross-origin fetch) so the key never enters the page's MAIN world and we dodge
// youtube.com CORS/CSP. The content-script panel drives pagination + filtering.
const GAPI = 'https://www.googleapis.com/youtube/v3';

function csNorm(c: any, isReply: boolean): CsComment {
  const s = c?.snippet ?? {};
  return {
    id: c?.id ?? '',
    parentId: s.parentId,
    isReply,
    author: s.authorDisplayName ?? '',
    authorChannelId: s.authorChannelId?.value,
    authorAvatar: s.authorProfileImageUrl,
    text: s.textDisplay ?? s.textOriginal ?? '',
    likeCount: typeof s.likeCount === 'number' ? s.likeCount : 0,
    publishedAt: s.publishedAt ?? '',
  };
}

function csMapError(status: number, body: any): { error: string; reason?: string } {
  const e = body?.error;
  const reason: string | undefined = e?.errors?.[0]?.reason || e?.status;
  const msg: string = e?.message || '';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')
    return { error: 'Your YouTube API daily quota is used up — it resets at midnight Pacific, or use another key.', reason };
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
    return { error: 'Hit the YouTube API rate limit — wait a few seconds and try again.', reason };
  if (reason === 'commentsDisabled') return { error: 'Comments are turned off for this video.', reason };
  if (reason === 'videoNotFound') return { error: 'The API couldn’t find this video.', reason };
  if (/API key not valid/i.test(msg) || reason === 'keyInvalid')
    return { error: 'Your API key is invalid or not authorized for the YouTube Data API. Check it in settings.', reason: 'keyInvalid' };
  if (status === 403)
    return { error: msg || 'The API rejected the request (403). Is the YouTube Data API v3 enabled for this key?', reason: reason || 'forbidden' };
  if (status === 400) return { error: msg || 'The API rejected the request (400).', reason: reason || 'badRequest' };
  return { error: msg || `YouTube API error (${status}).`, reason };
}

async function fetchCommentsPage(
  videoId: string,
  pageToken: string | undefined,
  order: 'relevance' | 'time'
): Promise<CommentsPageResult> {
  const key = (await loadSettings()).apiKey?.trim();
  if (!key) return { ok: false, error: 'No API key set yet. Add one in settings.', reason: 'noKey' };
  const u = new URL(`${GAPI}/commentThreads`);
  u.searchParams.set('part', 'snippet,replies');
  u.searchParams.set('videoId', videoId);
  u.searchParams.set('maxResults', '100');
  u.searchParams.set('order', order === 'time' ? 'time' : 'relevance');
  u.searchParams.set('textFormat', 'plainText');
  u.searchParams.set('key', key);
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  try {
    const res = await fetch(u.toString());
    void bumpQuota(); // a response means the API processed the request (1 unit)
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, ...csMapError(res.status, body) };
    const threads: CsThread[] = (body?.items ?? []).map((it: any) => {
      const top = csNorm(it?.snippet?.topLevelComment, false);
      const replies: CsComment[] = (it?.replies?.comments ?? []).map((r: any) => csNorm(r, true));
      const totalReplyCount =
        typeof it?.snippet?.totalReplyCount === 'number' ? it.snippet.totalReplyCount : replies.length;
      return { top, replies, totalReplyCount, hasMoreReplies: totalReplyCount > replies.length };
    });
    return { ok: true, threads, nextPageToken: body?.nextPageToken };
  } catch {
    return { ok: false, error: 'Couldn’t reach the YouTube API (network error).', reason: 'network' };
  }
}

async function fetchRepliesPage(parentId: string, pageToken: string | undefined): Promise<RepliesPageResult> {
  const key = (await loadSettings()).apiKey?.trim();
  if (!key) return { ok: false, error: 'No API key set.', reason: 'noKey' };
  const u = new URL(`${GAPI}/comments`);
  u.searchParams.set('part', 'snippet');
  u.searchParams.set('parentId', parentId);
  u.searchParams.set('maxResults', '100');
  u.searchParams.set('textFormat', 'plainText');
  u.searchParams.set('key', key);
  if (pageToken) u.searchParams.set('pageToken', pageToken);
  try {
    const res = await fetch(u.toString());
    void bumpQuota(); // a response means the API processed the request (1 unit)
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, ...csMapError(res.status, body) };
    const replies: CsComment[] = (body?.items ?? []).map((r: any) => csNorm(r, true));
    return { ok: true, replies, nextPageToken: body?.nextPageToken };
  } catch {
    return { ok: false, error: 'Couldn’t reach the YouTube API (network error).', reason: 'network' };
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
      handleWipe(msg.mode, msg.startMs, msg.endMs, msg.authUser, msg.pageId).then(sendResponse);
      return true;

    case 'SYF_OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;

    case 'SYF_OPEN_PAGE': {
      (async () => {
        const q = new URLSearchParams();
        if (msg.minutes) q.set('minutes', String(msg.minutes));
        const route = await resolveAccountRoute(msg.authUser, msg.pageId);
        if (route.authUser) q.set('authuser', route.authUser);
        if (route.pageId) q.set('pageId', route.pageId);
        const suffix = q.toString() ? `?${q}` : '';
        await chrome.tabs.create({ url: chrome.runtime.getURL('wipe/wipe.html') + suffix });
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'SYF_RELAY_REPLAY':
      relayReplay(msg.token).then(sendResponse);
      return true;

    case 'SYF_HISTORY':
      handleHistory(msg.action, msg.authUser, msg.pageId).then(async (res) => {
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

    case 'SYF_ACCOUNT': {
      // The active YouTube account (opaque ytcfg fingerprint). If it differs from the last one
      // we saw, the cached feedback tokens + action log belong to a DIFFERENT account and must
      // not be replayed against this one — clear them. First sight (no stored id) just records
      // the id/auth slot, so we never clear a legitimate existing cache on upgrade/first run.
      const accountId = msg.accountId;
      const authUser = normalizeAuthUser(msg.authUser);
      const pageId = normalizePageId(msg.pageId);
      if (accountId) {
        // Ordered after pending writes (like SYF_RESET) so an in-flight save can't resurrect data.
        enqueue(async () => {
          const o = await chrome.storage.local.get(ACCOUNT_KEY);
          const prev = storedAccount(o[ACCOUNT_KEY]);
          const nextAuthUser = authUser || (prev.id === accountId ? prev.authUser || '' : '');
          const nextPageId = pageId || (prev.id === accountId ? prev.pageId || '' : '');
          const next = { id: accountId, authUser: nextAuthUser, pageId: nextPageId };
          if (prev.id && prev.id !== accountId) {
            // Cancel any pending throttled cache flush so it can't write stale data back.
            if (flushTimer) {
              clearTimeout(flushTimer);
              flushTimer = null;
            }
            cacheDirty = false;
            await chrome.storage.local.set({
              [FEEDBACK_KEY]: emptyCache(),
              [ACTIONLOG_KEY]: [],
              [ACCOUNT_KEY]: next,
            });
            invalidateMem();
            console.log('[SYF] account changed — cleared feedback cache + action log');
          } else if (prev.id !== accountId || prev.authUser !== nextAuthUser || prev.pageId !== nextPageId) {
            await chrome.storage.local.set({ [ACCOUNT_KEY]: next });
          }
        });
      }
      sendResponse({ ok: true });
      return false;
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

    case 'SYF_OPEN_COMMENT_SEARCH': {
      const u =
        chrome.runtime.getURL('comments/search.html') +
        `?v=${encodeURIComponent(msg.videoId)}&title=${encodeURIComponent(msg.title || '')}`;
      // A normal browser window (title bar + chrome), modestly sized — not a big popup.
      // Enable the header-strip ruleset now so the bottom pane can frame the real watch page;
      // syncIframeRuleset (on window/tab close) turns it back off when no search tab remains.
      void setIframeRuleset(true);
      chrome.windows.create({ url: u, type: 'normal', width: 940, height: 820 });
      sendResponse({ ok: true });
      return false;
    }

    case 'SYF_COMMENTS_PAGE':
      fetchCommentsPage(msg.videoId, msg.pageToken, msg.order === 'time' ? 'time' : 'relevance').then(sendResponse);
      return true;

    case 'SYF_COMMENT_REPLIES':
      fetchRepliesPage(msg.parentId, msg.pageToken).then(sendResponse);
      return true;

    case 'SYF_GET_QUOTA':
      getQuotaState().then(sendResponse);
      return true;

    case 'SYF_RESET_QUOTA':
      resetQuota().then(() => sendResponse({ ok: true }));
      return true;

    default:
      return false;
  }
});
