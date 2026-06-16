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

function classifyMenu(menu: any): {
  notInterestedToken?: string;
  dontRecommendChannelToken?: string;
} {
  const res: { notInterestedToken?: string; dontRecommendChannelToken?: string } = {};
  const items = menu?.menuRenderer?.items;
  if (!Array.isArray(items)) return res;
  for (const it of items) {
    const mi = it.menuServiceItemRenderer;
    const token = mi?.serviceEndpoint?.feedbackEndpoint?.feedbackToken;
    if (!token) continue;
    const icon = mi.icon?.iconType;
    const label = (textOf(mi.text) || '').toLowerCase();
    if (icon === 'HIDE' || label.includes('not interested')) res.notInterestedToken = token;
    else if (icon === 'REMOVE' || label.includes("don't recommend") || label.includes('dont recommend'))
      res.dontRecommendChannelToken = token;
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
      const { notInterestedToken, dontRecommendChannelToken } = classifyMenu(o.menu);
      if (notInterestedToken || dontRecommendChannelToken) {
        const { channelName, channelId } = bylineChannel(o);
        out.push({
          videoId: o.videoId,
          channelId,
          channelName,
          title: textOf(o.title),
          notInterestedToken,
          dontRecommendChannelToken,
          sourcePage: location.pathname,
        });
      }
    }
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(root, 0);
  return out;
}

function captureFrom(root: any): void {
  try {
    const items = extractTuples(root);
    if (items.length) post('CAPTURE', { items });
  } catch {
    /* noop */
  }
}

// --- hook fetch to catch infinite-scroll / up-next / search continuations ---
const origFetch = window.fetch;
window.fetch = function (this: unknown, ...args: any[]) {
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

// Real submission requested by the isolated content script (button UI path).
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d: any = e.data;
  if (!d || d.__syf !== true || d.dir !== 'to-page' || d.type !== 'REPLAY') return;
  submitFeedback(d.token).then((result) =>
    post('REPLAY_RESULT', { action: d.action, requestId: d.requestId, result })
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
