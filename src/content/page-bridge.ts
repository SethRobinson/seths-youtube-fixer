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

function classifyMenu(menu: any): {
  notInterestedToken?: string;
  notInterestedUndoToken?: string;
  dontRecommendChannelToken?: string;
  dontRecommendChannelUndoToken?: string;
} {
  const res: ReturnType<typeof classifyMenu> = {};
  const items = menu?.menuRenderer?.items;
  if (!Array.isArray(items)) return res;
  for (const it of items) {
    const mi = it.menuServiceItemRenderer;
    const fe = mi?.serviceEndpoint?.feedbackEndpoint;
    const token = fe?.feedbackToken;
    if (!token) continue;
    const undo = findUndoToken(fe);
    const icon = mi.icon?.iconType;
    const label = (textOf(mi.text) || '').toLowerCase();
    if (icon === 'HIDE' || label.includes('not interested')) {
      res.notInterestedToken = token;
      res.notInterestedUndoToken = undo;
    } else if (icon === 'REMOVE' || label.includes("don't recommend") || label.includes('dont recommend')) {
      res.dontRecommendChannelToken = token;
      res.dontRecommendChannelUndoToken = undo;
    }
  }
  return res;
}

function findChannelId(node: any, d = 0): string | undefined {
  if (!node || typeof node !== 'object' || d > 5) return undefined;
  const bid = node.browseEndpoint?.browseId;
  if (typeof bid === 'string' && bid.startsWith('UC')) return bid;
  for (const k of Object.keys(node)) {
    const r = findChannelId(node[k], d + 1);
    if (r) return r;
  }
  return undefined;
}

function bylineChannel(node: any): { channelName?: string; channelId?: string } {
  const channelName = textOf(node?.longBylineText) || textOf(node?.ownerText) || textOf(node?.shortBylineText);
  const channelId =
    findChannelId(node?.longBylineText) ||
    findChannelId(node?.ownerText) ||
    findChannelId(node?.shortBylineText) ||
    findChannelId(node?.channelThumbnailSupportedRenderers) ||
    findChannelId(node?.channelThumbnail);
  return { channelName, channelId };
}

function extractTuples(root: any): any[] {
  const out: any[] = [];
  const seen = new WeakSet<object>();
  (function walk(o: any, d: number) {
    if (!o || typeof o !== 'object' || d > 40) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      for (const v of o) walk(v, d + 1);
      return;
    }
    if (typeof o.videoId === 'string' && o.videoId.length === 11 && o.menu) {
      const c = classifyMenu(o.menu);
      if (c.notInterestedToken || c.dontRecommendChannelToken) {
        const { channelName, channelId } = bylineChannel(o);
        out.push({
          videoId: o.videoId,
          channelId,
          channelName,
          title: textOf(o.title),
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
