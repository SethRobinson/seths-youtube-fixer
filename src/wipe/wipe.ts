// Standalone Forget recent page (opened in its own tab). Talks to the service
// worker (SYF_WIPE), which drives My Activity in a background tab.
import type { SyfMessage } from '../common/messages';

const root = document.getElementById('root') as HTMLDivElement;
const PRESETS = [15, 30, 60, 120];
const PARAMS = new URLSearchParams(location.search);
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const normalizeAuthUser = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
};
const normalizePageId = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
};
const AUTH_USER = normalizeAuthUser(PARAMS.get('authuser'));
const PAGE_ID = normalizePageId(PARAMS.get('pageId'));
function activityUrl(): string {
  const u = new URL(PAGE_ID ? `https://myactivity.google.com/b/${PAGE_ID}/product/youtube` : 'https://myactivity.google.com/product/youtube');
  if (AUTH_USER) u.searchParams.set('authuser', AUTH_USER);
  if (PAGE_ID) u.searchParams.set('pageId', PAGE_ID);
  return u.href;
}
function activityLink(): string {
  return `<a href="${activityUrl()}" target="_blank" rel="noopener">YouTube activity</a>`;
}

const titleActivityLink = document.getElementById('activityLink') as HTMLAnchorElement | null;
if (titleActivityLink) titleActivityLink.href = activityUrl();

function withBack(html: string): void {
  root.innerHTML = html + '<div class="actions"><button class="btn" id="back">Back</button></div>';
  root.querySelector('#back')!.addEventListener('click', renderPick);
}

function renderPick(): void {
  root.innerHTML = `
    <p class="note">Forgets <b>all</b> ${activityLink()} (watches &amp; searches) in the chosen window from your Google account via My Activity. This affects your account — not just this browser — and <b>can’t be undone</b>.</p>
    <div class="presets">
      ${PRESETS.map((m) => `<button class="btn preset" data-min="${m}">Last ${m} min</button>`).join('')}
      <span class="custom"><input id="cmin" type="number" min="1" max="1440" placeholder="custom" /> min
        <button class="btn" id="customGo">Scan</button></span>
    </div>`;
  root.querySelectorAll('.preset').forEach((b) =>
    b.addEventListener('click', () => void scan(Number((b as HTMLElement).dataset.min)))
  );
  const cmin = root.querySelector('#cmin') as HTMLInputElement;
  const go = () => {
    const v = Number(cmin.value);
    if (v > 0) void scan(v);
  };
  root.querySelector('#customGo')!.addEventListener('click', go);
  cmin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
}

async function scan(minutes: number): Promise<void> {
  root.innerHTML = `<div class="loading">Scanning ${activityLink()} for the last ${minutes} min… (opens My Activity in a background tab — this can take ~10s)</div>`;
  const endMs = Date.now();
  const startMs = endMs - minutes * 60_000;
  const res = await chrome.runtime.sendMessage({
    type: 'SYF_WIPE',
    mode: 'scan',
    startMs,
    endMs,
    authUser: AUTH_USER,
    pageId: PAGE_ID,
  } as SyfMessage);
  renderReview(startMs, endMs, res);
}

function renderReview(startMs: number, endMs: number, res: any): void {
  if (!res?.ok) {
    withBack(`<div class="error">Scan failed: ${esc(res?.error || 'unknown')}.<br/>Make sure you’re signed into Google in this browser.</div>`);
    return;
  }
  const matched: any[] = res.matched || [];
  if (!matched.length) {
    withBack(`<div class="loading">No ${activityLink()} found between <b>${fmtTime(startMs)}</b> and <b>${fmtTime(endMs)}</b>.</div>`);
    return;
  }
  root.innerHTML = `
    <p class="note">About to delete <b>${matched.length}</b> item(s) from ${activityLink()}, <b>${fmtTime(startMs)}</b> to <b>${fmtTime(endMs)}</b>. <b>This can’t be undone.</b></p>
    <div class="list">${matched
      .map((m) => `<div class="item"><span class="t">${esc(m.timeText)}</span> ${esc((m.title || '').slice(0, 80))}</div>`)
      .join('')}</div>
    <div class="actions">
      <button class="btn" id="cancel">Cancel</button>
      <button class="btn delete" id="del">Delete ${matched.length} item(s)</button>
    </div>`;
  root.querySelector('#cancel')!.addEventListener('click', renderPick);
  root.querySelector('#del')!.addEventListener('click', () => void doDelete(startMs, endMs, matched.length));
}

async function doDelete(startMs: number, endMs: number, count: number): Promise<void> {
  root.innerHTML = `<div class="loading">Deleting ${count} item(s) via My Activity…</div>`;
  const res = await chrome.runtime.sendMessage({
    type: 'SYF_WIPE',
    mode: 'delete',
    startMs,
    endMs,
    authUser: AUTH_USER,
    pageId: PAGE_ID,
  } as SyfMessage);
  if (res?.ok) {
    withBack(`<div class="done">✓ Deleted ${res.deleted ?? 0} item(s) from ${activityLink()}, ${fmtTime(startMs)} to ${fmtTime(endMs)}.</div>`);
  } else {
    withBack(`<div class="error">Delete failed: ${esc(res?.error || 'unknown')}.</div>`);
  }
}

// If a window was chosen on the in-page dialog, jump straight to scanning.
const initMin = Number(PARAMS.get('minutes'));
if (initMin > 0) void scan(initMin);
else renderPick();
