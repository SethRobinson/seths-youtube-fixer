// MAIN-world bridge: reads YouTube's innertube JSON to capture "Not interested"
// and "Don't recommend channel" feedback tokens, and reports the current watch
// video's context. Talks to the isolated content script via window.postMessage.
// No chrome.* APIs here. Captures only; it never submits feedback (yet).

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
function indexTuple(t: any): void {
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

function captureFrom(root: any): void {
  try {
    const items = extractTuples(root);
    for (const t of items) indexTuple(t);
    if (items.length) post('CAPTURE', { items });
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

// --- real feedback submission (POST /youtubei/v1/feedback) ---
const YT_ORIGIN = 'https://www.youtube.com';

function getCookie(name: string): string {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

async function sha1Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// YouTube authenticates innertube writes with: SAPISIDHASH <ts>_<sha1(ts SAPISID origin)>
async function sapisidHash(): Promise<string> {
  const sap =
    getCookie('SAPISID') || getCookie('__Secure-3PAPISID') || getCookie('__Secure-1PAPISID');
  const ts = Math.floor(Date.now() / 1000);
  const h = await sha1Hex(`${ts} ${sap} ${YT_ORIGIN}`);
  return `SAPISIDHASH ${ts}_${h}`;
}

function ytcfgGet(k: string): any {
  const c: any = (window as any).ytcfg;
  return c?.get?.(k) ?? c?.data_?.[k];
}

async function submitFeedback(token: string): Promise<any> {
  try {
    const apiKey = ytcfgGet('INNERTUBE_API_KEY');
    const res = await origFetch(`${YT_ORIGIN}/youtubei/v1/feedback?key=${apiKey}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await sapisidHash(),
        'X-Origin': YT_ORIGIN,
        'X-Goog-AuthUser': '0',
        'X-Youtube-Client-Name': String(ytcfgGet('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 1),
        'X-Youtube-Client-Version': String(ytcfgGet('INNERTUBE_CONTEXT_CLIENT_VERSION') ?? ''),
      },
      body: JSON.stringify({
        context: ytcfgGet('INNERTUBE_CONTEXT'),
        feedbackTokens: [token],
        isFeedbackTokenUnencrypted: false,
        shouldMerge: false,
      }),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Exposed for controlled validation from the test harness.
(window as any).__syfSubmitFeedback = submitFeedback;
(window as any).__syfDebug = {
  size: () => tokenIndex.size,
  firstToken: () => tokenIndex.keys().next().value,
  hasToken: (t: string) => tokenIndex.has(t),
};

// Real submission requested by the isolated content script (button UI path).
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d: any = e.data;
  if (!d || d.__syf !== true || d.dir !== 'to-page' || d.type !== 'REPLAY') return;
  submitFeedback(d.token).then((result) =>
    post('REPLAY_RESULT', { action: d.action, mode: d.mode, requestId: d.requestId, result })
  );
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

// --- triggers: parse embedded data + watch context after each navigation ---
function onNavigate(): void {
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    if ((window as any).ytInitialData) captureFrom((window as any).ytInitialData);
    readWatchContext();
    if (tries >= 6) clearInterval(iv);
  }, 700);
}

window.addEventListener('yt-navigate-finish', onNavigate);
onNavigate();
post('BRIDGE_READY');
