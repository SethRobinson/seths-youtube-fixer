// MAIN-world bridge: reads YouTube's innertube JSON to capture "Not interested"
// and "Don't recommend channel" feedback tokens, and reports the current watch
// video's context. Talks to the isolated content script via window.postMessage.
// No chrome.* APIs here. It also submits feedback (Nah/Hate/pause-history) on
// request from the isolated content script via a 'to-page' REPLAY message.

interface BridgeMsg {
  __syf: true;
  dir: 'from-page';
  type: string;
  [k: string]: unknown;
}

function post(type: string, payload: Record<string, unknown> = {}): void {
  const msg: BridgeMsg = { __syf: true, dir: 'from-page', type, ...payload };
  window.postMessage(msg, location.origin);
}

function textOf(t: any): string | undefined {
  try {
    if (t?.runs) return t.runs.map((r: any) => r.text).join('');
    if (t?.simpleText) return t.simpleText;
  } catch {
    /* noop */
  }
  return undefined;
}

// The undo token lives under feedbackEndpoint.actions[]…undoFeedbackEndpoint.undoToken.
function findUndoToken(node: any, d = 0): string | undefined {
  if (!node || typeof node !== 'object' || d > 15) return undefined;
  if (typeof node.undoToken === 'string') return node.undoToken;
  for (const k of Object.keys(node)) {
    const r = findUndoToken(node[k], d + 1);
    if (r) return r;
  }
  return undefined;
}

// Label/icon work for both classic (text.runs / icon.iconType) and the new
// lockup view-model (title.content / leadingImage…clientResource.imageName).
function labelOf(o: any): string {
  return (o?.title?.content || textOf(o?.text) || '').toLowerCase();
}
function iconOf(o: any): string {
  return o?.leadingImage?.sources?.[0]?.clientResource?.imageName || o?.icon?.iconType || '';
}

// Find the feedbackEndpoint (carrying feedbackToken) inside a menu item — handles
// classic serviceEndpoint.feedbackEndpoint and lockup
// rendererContext.commandContext.onTap.innertubeCommand.feedbackEndpoint.
function findFeedbackEndpoint(o: any, d = 0): any {
  if (!o || typeof o !== 'object' || d > 8) return null;
  if (o.feedbackEndpoint && typeof o.feedbackEndpoint.feedbackToken === 'string') return o.feedbackEndpoint;
  if (typeof o.feedbackToken === 'string') return o;
  for (const k of Object.keys(o)) {
    const r = findFeedbackEndpoint(o[k], d + 1);
    if (r) return r;
  }
  return null;
}

// Walk a card/menu container for "Not interested" / "Don't recommend channel"
// items (works regardless of classic vs lockup shape).
function classify(container: any): {
  notInterestedToken?: string;
  notInterestedUndoToken?: string;
  dontRecommendChannelToken?: string;
  dontRecommendChannelUndoToken?: string;
} {
  const res: ReturnType<typeof classify> = {};
  const seen = new WeakSet<object>();
  (function walk(o: any, d: number) {
    if (!o || typeof o !== 'object' || d > 22) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const x of o) walk(x, d + 1);
      return;
    }
    const label = labelOf(o);
    const icon = iconOf(o);
    if (label || icon) {
      const fe = findFeedbackEndpoint(o, 0);
      if (fe && typeof fe.feedbackToken === 'string') {
        if (icon === 'HIDE' || label.includes('not interested')) {
          if (!res.notInterestedToken) {
            res.notInterestedToken = fe.feedbackToken;
            res.notInterestedUndoToken = findUndoToken(fe);
          }
        } else if (icon === 'REMOVE' || label.includes("don't recommend") || label.includes('dont recommend')) {
          if (!res.dontRecommendChannelToken) {
            res.dontRecommendChannelToken = fe.feedbackToken;
            res.dontRecommendChannelUndoToken = findUndoToken(fe);
          }
        }
        return; // matched item — don't descend further into it
      }
    }
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(container, 0);
  return res;
}

// Channel id = a "UC…" 24-char string anywhere in the node.
function findChannelId(node: any, d = 0): string | undefined {
  if (!node || typeof node !== 'object' || d > 12) return undefined;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string' && /^UC[0-9A-Za-z_-]{22}$/.test(v)) return v;
    const r = findChannelId(v, d + 1);
    if (r) return r;
  }
  return undefined;
}

function bylineChannel(node: any): { channelName?: string; channelId?: string } {
  const channelName = textOf(node?.longBylineText) || textOf(node?.ownerText) || textOf(node?.shortBylineText);
  return { channelName, channelId: findChannelId(node) };
}

function lockupTitle(lv: any): string | undefined {
  return lv?.metadata?.lockupMetadataViewModel?.title?.content;
}

function extractTuples(root: any): any[] {
  const out: any[] = [];
  const seen = new WeakSet<object>();
  (function walk(o: any, d: number) {
    if (!o || typeof o !== 'object' || d > 45) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const v of o) walk(v, d + 1);
      return;
    }

    let videoId: string | undefined;
    let container: any;
    let channel: { channelName?: string; channelId?: string } = {};
    let title: string | undefined;

    if (typeof o.videoId === 'string' && o.videoId.length === 11 && o.menu) {
      videoId = o.videoId;
      container = o.menu;
      channel = bylineChannel(o);
      title = textOf(o.title);
    } else if (
      o.lockupViewModel &&
      typeof o.lockupViewModel.contentId === 'string' &&
      o.lockupViewModel.contentId.length === 11
    ) {
      const lv = o.lockupViewModel;
      videoId = lv.contentId;
      container = lv;
      channel = { channelId: findChannelId(lv) };
      title = lockupTitle(lv);
    }

    if (videoId && container) {
      const c = classify(container);
      if (c.notInterestedToken || c.dontRecommendChannelToken) {
        out.push({
          videoId,
          channelId: channel.channelId,
          channelName: channel.channelName,
          title,
          notInterestedToken: c.notInterestedToken,
          notInterestedUndoToken: c.notInterestedUndoToken,
          dontRecommendChannelToken: c.dontRecommendChannelToken,
          dontRecommendChannelUndoToken: c.dontRecommendChannelUndoToken,
          sourcePage: location.pathname,
        });
      }
    }
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(root, 0);
  return out;
}

// Index captured tokens so we can identify NATIVE feedback the user triggers
// via YouTube's own menus (and offer the same logging/undo).
const tokenIndex = new Map<string, any>();
const undoIndex = new Map<string, any>();
const videoIndex = new Map<string, any>(); // videoId -> capture tuple, for click-time capture
function indexTuple(t: any): void {
  if (t.videoId) videoIndex.set(t.videoId, t);
  if (t.notInterestedToken)
    tokenIndex.set(t.notInterestedToken, {
      type: 'notInterested',
      videoId: t.videoId,
      channelId: t.channelId,
      title: t.title,
      channelName: t.channelName,
      actionToken: t.notInterestedToken,
      undoToken: t.notInterestedUndoToken,
    });
  if (t.notInterestedUndoToken)
    undoIndex.set(t.notInterestedUndoToken, { type: 'notInterested', videoId: t.videoId, channelId: t.channelId });
  if (t.dontRecommendChannelToken)
    tokenIndex.set(t.dontRecommendChannelToken, {
      type: 'dontRecommendChannel',
      videoId: t.videoId,
      channelId: t.channelId,
      title: t.title,
      channelName: t.channelName,
      actionToken: t.dontRecommendChannelToken,
      undoToken: t.dontRecommendChannelUndoToken,
    });
  if (t.dontRecommendChannelUndoToken)
    undoIndex.set(t.dontRecommendChannelUndoToken, { type: 'dontRecommendChannel', videoId: t.videoId, channelId: t.channelId });
}

// window.ytInitialData is FROZEN at the first full page load. After an SPA
// navigation (e.g. clicking sidebar videos while watching) it is never updated,
// and YouTube serves the new "watch next" data WITHOUT a /next request we can
// hook — the live page state lives on the polymer elements instead. So read the
// element data: ytd-watch-flexy.data (watch), ytd-browse.data (home/feeds),
// ytd-search.data (results). This is the root-cause fix for "Hate content stays
// gray on sidebar-clicked videos" — every video that rotated into the sidebar
// after the first SPA nav was previously never captured.
function liveRoots(): any[] {
  const roots: any[] = [];
  const add = (sel: string) => {
    const d = (document.querySelector(sel) as any)?.data;
    if (d) roots.push(d);
  };
  // Read only the container for the current page type (avoids walking a hidden,
  // stale ytd-browse left over from a previous SPA view).
  const path = location.pathname;
  if (path === '/watch') add('ytd-watch-flexy');
  else if (path === '/results') add('ytd-search');
  else add('ytd-browse'); // home, /feed/*, channel pages, etc.
  // Fall back to ytInitialData only before the polymer element has hydrated
  // (very first paint of a full load).
  if (!roots.length && (window as any).ytInitialData) roots.push((window as any).ytInitialData);
  return roots;
}

function captureFrom(root: any): void {
  try {
    const items = extractTuples(root);
    const fresh: any[] = [];
    for (const t of items) {
      const prev = videoIndex.get(t.videoId);
      // Only push to the SW when the video is new or its token changed — avoids
      // re-sending the whole sidebar on every 700ms tick / every navigation.
      if (
        !prev ||
        prev.notInterestedToken !== t.notInterestedToken ||
        prev.dontRecommendChannelToken !== t.dontRecommendChannelToken
      ) {
        fresh.push(t);
      }
      indexTuple(t);
    }
    if (fresh.length) post('CAPTURE', { items: fresh });
  } catch {
    /* noop */
  }
}

// Capture one specific video on demand (the user just clicked it) so its data is
// guaranteed in the cache before navigation, even under fast clicking. Reads the
// LIVE element data (not stale ytInitialData) so it works after SPA navigation.
function captureVideo(videoId: string): void {
  try {
    let t = videoIndex.get(videoId);
    if (!t) {
      for (const root of liveRoots()) {
        const found = extractTuples(root).find((x: any) => x.videoId === videoId);
        if (found) {
          indexTuple(found);
          t = found;
          break;
        }
      }
    }
    if (t) post('CAPTURE', { items: [t] });
  } catch {
    /* noop */
  }
}

// --- hook fetch to catch infinite-scroll / up-next / search continuations ---
// Detect native feedback the user submits through YouTube's own UI. Our own
// submissions go through origFetch (below), so they are NOT seen here.
function inspectNativeFeedback(init: any): void {
  try {
    const bodyStr = typeof init?.body === 'string' ? init.body : null;
    if (!bodyStr) return;
    const tokens = JSON.parse(bodyStr)?.feedbackTokens || [];
    for (const t of tokens) {
      const info = tokenIndex.get(t);
      if (info) {
        post('NATIVE_ACTION', { info });
        continue;
      }
      const undoInfo = undoIndex.get(t);
      if (undoInfo) post('NATIVE_UNDO', { info: undoInfo });
    }
  } catch {
    /* noop */
  }
}

const origFetch = window.fetch;
window.fetch = function (this: unknown, ...args: any[]) {
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url;
    if (url && /\/youtubei\/v1\/feedback/.test(url)) inspectNativeFeedback(args[1]);
  } catch {
    /* noop */
  }
  const p = origFetch.apply(this, args as any);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input?.url;
    if (url && /\/youtubei\/v1\/(browse|next|search|guide)/.test(url)) {
      p.then((res: Response) => {
        res
          .clone()
          .json()
          .then((j) => captureFrom(j))
          .catch(() => {});
      }).catch(() => {});
    }
  } catch {
    /* noop */
  }
  return p;
};

// The page's innertube config feeds the isolated content script's authenticated feedback
// POST — which it performs itself, reading SAPISID from document.cookie. No feedback
// submission (and no SAPISIDHASH signing) happens in this page world anymore.
function ytcfgGet(k: string): any {
  const c: any = (window as any).ytcfg;
  return c?.get?.(k) ?? c?.data_?.[k];
}

// Hand the page's PUBLIC innertube config (api key + client context — not secrets) to the
// isolated content script so IT can perform the authenticated feedback POST itself, reading
// SAPISID straight from document.cookie. Submission no longer happens in this page world, so a
// hostile page-world script can't forge a message to write feedback with the user's session.
// Posted on demand (the isolated script polls REQUEST_CONFIG until it has it, since ytcfg may
// not be ready yet and the isolated script loads after this one).
function postConfig(): void {
  const apiKey = ytcfgGet('INNERTUBE_API_KEY');
  const context = ytcfgGet('INNERTUBE_CONTEXT');
  if (!apiKey || !context) return;
  post('YT_CONFIG', {
    apiKey,
    context,
    clientName: ytcfgGet('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1,
    clientVersion: ytcfgGet('INNERTUBE_CONTEXT_CLIENT_VERSION') ?? '',
  });
}

// Dev-only READ hook for tests (token-index peek). The account-write primitive that used
// to live here is gone — feedback submission moved to the isolated content script — so the
// page world no longer exposes any way to write feedback. Compiled out unless SYF_DEV=1.
declare const __SYF_DEV__: boolean;
if (__SYF_DEV__) {
  (window as any).__syfDebug = {
    size: () => tokenIndex.size,
    firstToken: () => tokenIndex.keys().next().value,
    hasToken: (t: string) => tokenIndex.has(t),
  };
}

// Requests from the isolated content script. Both are read-only / non-authenticated:
// re-capture a clicked video, or (re)send the page's innertube config. The bridge no
// longer exposes a feedback-submit primitive to the page world — that moved to the
// isolated world so a page-world script can't forge a message to write feedback.
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d: any = e.data;
  if (!d || d.__syf !== true || d.dir !== 'to-page') return;
  if (d.type === 'CAPTURE_VIDEO' && typeof d.videoId === 'string') {
    captureVideo(d.videoId);
  } else if (d.type === 'REQUEST_CONFIG') {
    postConfig();
  }
});

// --- current watch-page context (works across SPA nav via the live player) ---
function readWatchContext(): void {
  try {
    const mp: any = document.getElementById('movie_player');
    const pr = mp?.getPlayerResponse?.();
    const vd = pr?.videoDetails;
    if (vd?.videoId) {
      post('WATCH_CONTEXT', {
        videoId: vd.videoId,
        channelId: vd.channelId,
        channelName: vd.author,
        title: vd.title,
      });
    }
  } catch {
    /* noop */
  }
}

// --- watch-history pause/resume token (only present on /feed/history) ---
function readHistoryInfo(): void {
  if (!/\/feed\/history/.test(location.pathname)) return;
  try {
    // ytd-browse.data is the live (SPA-fresh) source; ytInitialData is only
    // correct on a full load and goes stale after navigation.
    const data = (document.querySelector('ytd-browse') as any)?.data || (window as any).ytInitialData;
    if (!data) return;
    let token: string | null = null;
    let paused: boolean | null = null;
    const seen = new WeakSet<object>();
    (function walk(o: any) {
      if (token || !o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach(walk);
      const label = (textOf(o.text) || textOf(o.title) || (typeof o.content === 'string' ? o.content : '') || '').trim();
      if (/^pause watch history$/i.test(label) || /^turn on watch history$/i.test(label)) {
        paused = /^turn on/i.test(label);
        const s2 = new WeakSet<object>();
        (function dig(n: any, d: number) {
          if (token || !n || typeof n !== 'object' || d > 14 || s2.has(n)) return;
          s2.add(n);
          if (typeof n.feedbackToken === 'string') {
            token = n.feedbackToken;
            return;
          }
          for (const k of Object.keys(n)) dig(n[k], d + 1);
        })(o, 0);
      }
      for (const k of Object.keys(o)) walk(o[k]);
    })(data);
    post('HISTORY_INFO', { token, paused, found: !!token });
  } catch {
    /* noop */
  }
}

// --- triggers: parse embedded data + watch context after each navigation ---
function onNavigate(): void {
  let tries = 0;
  const tick = () => {
    for (const root of liveRoots()) captureFrom(root);
    readWatchContext();
    readHistoryInfo();
  };
  tick(); // capture immediately, then retry as the SPA hydrates
  const iv = setInterval(() => {
    tick();
    if (++tries >= 6) clearInterval(iv);
  }, 700);
}

window.addEventListener('yt-navigate-finish', onNavigate);
onNavigate();
post('BRIDGE_READY');
