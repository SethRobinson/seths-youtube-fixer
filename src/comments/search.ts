// Standalone "Find in comments" window. Top pane: matching comments (searched via
// the YouTube Data API through the service worker). Bottom pane: the REAL YouTube
// watch page, framed and scrolled to the clicked comment (header-stripped by our
// declarativeNetRequest rule), so Like/Reply happen natively. Draggable divider.
import { SETTINGS_KEY, DEFAULT_SCAN_CAP, MIN_SCAN_CAP, MAX_SCAN_CAP } from '../common/messages';
import type { SyfMessage, CommentsPageResult, RepliesPageResult, CsComment, CsThread, QuotaResult } from '../common/messages';

const params = new URLSearchParams(location.search);
const videoId = params.get('v') || '';
const videoTitle = params.get('title') || '';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const listEl = $('cs-list');
const statusEl = $('cs-status');
const frame = $<HTMLIFrameElement>('cs-frame');
const placeholder = $('cs-placeholder');
const qInput = $<HTMLInputElement>('cs-q');
const orderSel = $<HTMLSelectElement>('cs-order');
const repliesChk = $<HTMLInputElement>('cs-replies');
const goBtn = $<HTMLButtonElement>('cs-go');
const stopBtn = $<HTMLButtonElement>('cs-stop');
const quotaEl = $('cs-quota');

// Compact "API quota used today" readout (a local estimate — see the options page). Refreshed
// on open and after each search, since that's when our call count changes.
async function updateQuota(): Promise<void> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'SYF_GET_QUOTA' } as SyfMessage)) as QuotaResult | undefined;
    if (!r?.ok) return;
    const remaining = Math.max(0, r.limit - r.used);
    quotaEl.textContent = `API quota today: ~${r.used.toLocaleString()} / ${r.limit.toLocaleString()} units used · ~${remaining.toLocaleString()} left (estimate)`;
  } catch {
    /* ignore */
  }
}

$('cs-title').textContent = videoTitle || videoId || 'Comments';
const thumbEl = $<HTMLImageElement>('cs-thumb');
if (videoId) {
  thumbEl.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  thumbEl.title = 'Open this video in a new window';
  thumbEl.addEventListener('click', () => void openExternal(`https://www.youtube.com/watch?v=${videoId}`));
}
document.title = videoTitle ? `Find in comments — ${videoTitle}` : 'Find in comments';

// Open a video/channel link in a reused auxiliary window, kept separate from this
// search window so it doesn't clutter it (and reused so repeat clicks don't pile
// up windows). Falls back to a fresh window if that one was closed.
let auxWin: number | null = null;
async function openExternal(url: string): Promise<void> {
  try {
    if (auxWin != null) {
      try {
        await chrome.tabs.create({ windowId: auxWin, url, active: true });
        await chrome.windows.update(auxWin, { focused: true });
        return;
      } catch {
        auxWin = null; // window was closed
      }
    }
    const win = await chrome.windows.create({ url, focused: true });
    auxWin = win?.id ?? null;
  } catch {
    window.open(url, '_blank'); // last-ditch
  }
}

// --- text helpers ---
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function highlight(text: string, term: string): string {
  if (!term) return esc(text);
  const lc = text.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const idx = lc.indexOf(term, i);
    if (idx < 0) {
      out += esc(text.slice(i));
      break;
    }
    out += esc(text.slice(i, idx)) + '<mark class="cs-hl">' + esc(text.slice(idx, idx + term.length)) + '</mark>';
    i = idx + term.length;
  }
  return out;
}
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  const units: [string, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [n, sec] of units) {
    const v = Math.floor(s / sec);
    if (v >= 1) return `${v} ${n}${v > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}
function num(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function deepLink(commentId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}`;
}

// --- bottom pane ---
let selectedRow: HTMLElement | null = null;
function showBelow(commentId: string, row: HTMLElement): void {
  selectedRow?.classList.remove('cs-row-sel');
  selectedRow = row;
  row.classList.add('cs-row-sel');
  placeholder.style.display = 'none';
  frame.style.display = 'block';
  frame.src = deepLink(commentId);
}

// --- search state ---
// Comments are fetched once and CACHED in memory while this window stays open, so
// re-searching a different word just re-filters the cached set (0 API calls). The
// cache is reused for FRESH_MS; after that — or if "order"/"Replies too" changes —
// the next search re-fetches. Closing the window drops the cache (reopen re-fetches).
// How many comments to load before pausing for "Load more" — user-configurable
// (options page), loaded once when this window opens. Comments aren't stored, so this only
// bounds one scan's time + API quota.
let scanCap = DEFAULT_SCAN_CAP;
chrome.storage.local.get(SETTINGS_KEY).then((o) => {
  const v = (o[SETTINGS_KEY] as { commentScanCap?: number } | undefined)?.commentScanCap;
  if (typeof v === 'number' && Number.isFinite(v)) scanCap = Math.min(Math.max(v, MIN_SCAN_CAP), MAX_SCAN_CAP);
});
const FRESH_MS = 5 * 60 * 1000;

interface Store {
  order: 'relevance' | 'time';
  includeReplies: boolean;
  threads: CsThread[];
  done: boolean;
  pageToken?: string;
  fetchedAt: number;
  scanned: number; // comments fetched (top + replies)
  calls: number; // API calls used to build the cache
  threadsMore: number; // threads with unscanned extra replies (when !includeReplies)
}
let store: Store | null = null;
let term = ''; // current lowercased search term
let matched = 0; // matches rendered for the current term
let stop = false;
let busy = false;

function termMatch(text: string): boolean {
  return !!term && text.toLowerCase().includes(term);
}
function renderThread(th: CsThread): void {
  const hits: CsComment[] = [];
  if (termMatch(th.top.text)) hits.push(th.top);
  for (const r of th.replies) if (termMatch(r.text)) hits.push(r);
  if (!hits.length) return;
  matched += hits.length;
  for (const h of hits) listEl.appendChild(row(th, h));
}

function row(thread: CsThread, c: CsComment): HTMLElement {
  const el = document.createElement('div');
  el.className = 'cs-row';
  const avatar = c.authorAvatar
    ? `<img class="cs-av" src="${esc(c.authorAvatar)}" loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : `<div class="cs-av"></div>`;
  const context = c.isReply
    ? `<span class="cs-badge">reply</span><span>↳ to ${esc(thread.top.author || 'a comment')}</span>`
    : thread.totalReplyCount
      ? `<span>${num(thread.totalReplyCount)} repl${thread.totalReplyCount === 1 ? 'y' : 'ies'}</span>`
      : '';
  el.innerHTML = `${avatar}
    <div class="cs-main">
      <div class="cs-meta"><span class="cs-author">${esc(c.author)}</span><span>${esc(ago(c.publishedAt))}</span><span>👍 ${num(c.likeCount)}</span>${context}</div>
      <div class="cs-text">${highlight(c.text, term)}</div>
    </div>
    <button class="cs-open" title="Open this comment in a separate window">↗</button>`;
  el.addEventListener('click', () => showBelow(c.id, el));
  el.querySelector('.cs-open')!.addEventListener('click', (e) => {
    e.stopPropagation();
    void openExternal(deepLink(c.id));
  });
  // Author avatar/name → open that channel in a window (don't load it below).
  const channelUrl = c.authorChannelId ? `https://www.youtube.com/channel/${c.authorChannelId}` : null;
  if (channelUrl) {
    el.querySelectorAll('.cs-av, .cs-author').forEach((n) => {
      const node = n as HTMLElement;
      node.classList.add('cs-chan');
      node.title = `Open ${c.author || 'this channel'} in a new window`;
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        void openExternal(channelUrl);
      });
    });
  }
  return el;
}

function setStatus(html: string, running: boolean): void {
  statusEl.innerHTML = html;
  goBtn.style.display = running ? 'none' : '';
  stopBtn.style.display = running ? '' : 'none';
}
function progressHtml(): string {
  return `<span class="cs-spin"></span> Scanning… ${(store?.scanned ?? 0).toLocaleString()} comments · ${matched} match${matched === 1 ? '' : 'es'}`;
}

async function startSearch(): Promise<void> {
  const raw = qInput.value.trim();
  if (!raw) {
    qInput.focus();
    return;
  }
  term = raw.toLowerCase();
  matched = 0;
  stop = false;
  listEl.innerHTML = '';
  const order = orderSel.value === 'time' ? 'time' : 'relevance';
  const includeReplies = repliesChk.checked;

  // Reuse the in-memory comment cache when it's still fresh and the scan params
  // match — re-searching a new word then costs zero API quota.
  const reusable =
    !!store && Date.now() - store.fetchedAt < FRESH_MS && store.order === order && store.includeReplies === includeReplies;

  if (reusable) {
    for (const th of store!.threads) renderThread(th);
    finish(true);
  } else {
    store = {
      order,
      includeReplies,
      threads: [],
      done: false,
      pageToken: undefined,
      fetchedAt: Date.now(),
      scanned: 0,
      calls: 0,
      threadsMore: 0,
    };
    await fetchMore();
  }
}

// Fetch the next pages (from scratch, or resuming via store.pageToken for "Load
// more"), caching every thread so later searches re-filter without re-fetching.
async function fetchMore(): Promise<void> {
  if (!store) return;
  const s = store;
  busy = true;
  stop = false;
  setStatus(progressHtml(), true);
  try {
    while (!stop) {
      const res = (await chrome.runtime.sendMessage({
        type: 'SYF_COMMENTS_PAGE',
        videoId,
        pageToken: s.pageToken,
        order: s.order,
      } as SyfMessage)) as CommentsPageResult | undefined;
      s.calls++;
      if (!res?.ok) {
        finishError(res);
        return;
      }
      for (const th of res.threads ?? []) {
        if (stop) break;
        if (s.includeReplies && th.hasMoreReplies) th.replies = await fetchAllReplies(th.top.id, s);
        else if (!s.includeReplies && th.hasMoreReplies) s.threadsMore++;
        s.scanned += 1 + th.replies.length;
        s.threads.push(th);
        renderThread(th);
      }
      setStatus(progressHtml(), true);
      s.pageToken = res.nextPageToken;
      if (!s.pageToken) {
        s.done = true;
        break;
      }
      if (s.scanned >= scanCap) break; // pause for "Load more"
    }
  } finally {
    busy = false;
  }
  finish(false);
}

async function fetchAllReplies(parentId: string, s: Store): Promise<CsComment[]> {
  const out: CsComment[] = [];
  let token: string | undefined;
  for (;;) {
    if (stop) break;
    const res = (await chrome.runtime.sendMessage({
      type: 'SYF_COMMENT_REPLIES',
      parentId,
      pageToken: token,
    } as SyfMessage)) as RepliesPageResult | undefined;
    s.calls++;
    if (!res?.ok) break; // best-effort
    out.push(...(res.replies ?? []));
    token = res.nextPageToken;
    if (!token) break;
  }
  return out;
}

function finish(reused: boolean): void {
  if (!store) return;
  const s = store;
  if (!listEl.querySelector('.cs-row')) {
    listEl.innerHTML = `<div class="cs-empty">No comments matched “${esc(term)}” in the ${s.scanned.toLocaleString()} scanned.${
      !s.includeReplies && s.threadsMore ? ' Tip: enable “Replies too” to also search inside reply threads.' : ''
    }</div>`;
  }
  const canMore = !s.done && !!s.pageToken;
  const lead = s.done ? 'Done' : stop ? 'Stopped' : 'Paused';
  const repliesNote = !s.includeReplies && s.threadsMore ? ` · ${s.threadsMore} thread${s.threadsMore === 1 ? '' : 's'} had extra replies not scanned` : '';
  const callsNote = reused ? 'reused cached comments · 0 new API calls' : `${s.calls} API call${s.calls === 1 ? '' : 's'}`;
  setStatus(`${lead} — ${matched} match${matched === 1 ? '' : 'es'} · ${s.scanned.toLocaleString()} scanned · ${callsNote}${repliesNote}`, false);
  document.getElementById('cs-more')?.remove();
  if (canMore) {
    const more = document.createElement('button');
    more.id = 'cs-more';
    more.className = 'cs-btn';
    more.textContent = 'Load more';
    more.style.marginLeft = 'auto';
    more.addEventListener('click', () => {
      if (busy) return;
      more.remove();
      void fetchMore();
    });
    statusEl.appendChild(more);
  }
  void updateQuota(); // our call count just changed
}

function finishError(res: CommentsPageResult | undefined): void {
  busy = false;
  const msg = res?.error || 'The search failed.';
  setStatus(`<span class="cs-err">${esc(msg)}</span>`, false);
  if (!listEl.querySelector('.cs-row')) listEl.innerHTML = `<div class="cs-empty cs-err">${esc(msg)}</div>`;
  void updateQuota(); // even failed calls usually consumed quota
}

// --- draggable divider ---
const split = $('cs-split');
const divider = $('cs-divider');
let dragging = false;
divider.addEventListener('mousedown', (e) => {
  dragging = true;
  document.body.classList.add('cs-dragging');
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = split.getBoundingClientRect();
  const top = Math.max(80, Math.min(rect.height - 120, e.clientY - rect.top));
  split.style.gridTemplateRows = `${top}px 9px 1fr`;
});
window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('cs-dragging');
});

// --- wire up ---
goBtn.addEventListener('click', () => {
  if (!busy) void startSearch();
});
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !busy) void startSearch();
});
stopBtn.addEventListener('click', () => {
  stop = true;
});
qInput.focus();
void updateQuota();
