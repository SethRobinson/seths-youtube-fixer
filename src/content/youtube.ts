// Isolated-world content script: injects the button bar, forwards captures to the
// service worker, reflects availability, submits/undoes feedback (toggle), logs
// every action (incl. native YouTube actions), and shows an action-log panel.
import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  type SyfMessage,
  type LookupResult,
  type LogResult,
  type SyfSettings,
} from '../common/messages';
import type { ActionLogEntry } from '../common/feedback';

const TAG = '[SYF]';
const BAR_ID = 'syf-bar';
const MODAL_ID = 'syf-modal';

const NAH_TIP = 'Send YouTube’s real “Not interested” for this video.';
const HATE_TIP = 'Send YouTube’s real “Don’t recommend channel” for this creator.';
const NAH_UNAVAIL =
  'Not available yet — this video hasn’t been seen as a recommendation card with YouTube’s real feedback action.';
const HATE_UNAVAIL =
  'YouTube hasn’t exposed a real “Don’t recommend channel” action for this creator in this session yet.';

// Shown as a toast when a grayed-out button is clicked.
const NAH_REASON =
  '“Hate content” isn’t available for this video yet. YouTube only exposes a real “Not interested” action on recommendation cards — so we can only send it for videos we’ve seen as a card. Browse Home, Search, or the Up-next sidebar until this video appears there, then come back.';
const HATE_REASON =
  '“Hate channel” isn’t available yet. We haven’t captured YouTube’s real “Don’t recommend channel” action for this creator this session. Browse a few of their videos as recommendation cards (Home / Search / Up-next), then return here.';

interface BtnDef {
  action: string;
  label: string;
  tip: string;
}

const BUTTONS: BtnDef[] = [
  { action: 'nah', label: 'Hate content', tip: NAH_UNAVAIL },
  { action: 'hate-channel', label: 'Hate channel', tip: HATE_UNAVAIL },
  { action: 'wipe', label: 'Wipe history', tip: 'Delete recent YouTube activity via My Activity.' },
  { action: 'find-comments', label: 'Find in comments', tip: 'Search all public comments and replies.' },
  { action: 'info', label: 'ℹ Info', tip: 'View and undo your feedback actions.' },
];

const LABELS: Record<string, string> = { nah: 'Hate content', 'hate-channel': 'Hate channel' };
const SENT_LABELS: Record<string, string> = { nah: 'Content hidden ✓', 'hate-channel': 'Channel hidden ✓' };

interface ActionState {
  token?: string;
  undoToken?: string;
  activeId?: string;
  activeUndoToken?: string;
}

const buttons: Record<string, HTMLButtonElement> = {};
const state: Record<string, ActionState> = { nah: {}, 'hate-channel': {} };
let current: { videoId?: string; channelId?: string; channelName?: string; title?: string } = {};
let settings: SyfSettings = { ...DEFAULT_SETTINGS };

function applySettings(s: SyfSettings): void {
  settings = s;
  document.documentElement.classList.toggle('syf-hide-shorts', !!s.hideShorts);
}
chrome.storage.local.get(SETTINGS_KEY).then((o) => applySettings({ ...DEFAULT_SETTINGS, ...(o[SETTINGS_KEY] ?? {}) }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    applySettings({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue ?? {}) });
  }
});

function getVideoId(): string | null {
  const u = new URL(location.href);
  return u.pathname === '/watch' ? u.searchParams.get('v') : null;
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

function showToast(message: string): void {
  document.getElementById('syf-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'syf-toast';
  t.className = 'syf-toast';
  t.textContent = message;
  t.addEventListener('click', () => t.remove());
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('syf-toast-show'));
  setTimeout(() => {
    t.classList.remove('syf-toast-show');
    setTimeout(() => t.remove(), 250);
  }, 6500);
}

// --- promise-based replay through the MAIN-world bridge ---
const pending = new Map<string, (r: any) => void>();
function replay(token: string, mode: 'apply' | 'undo'): Promise<any> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID?.() ?? String(Math.random());
    pending.set(requestId, resolve);
    window.postMessage({ __syf: true, dir: 'to-page', type: 'REPLAY', token, mode, requestId }, location.origin);
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        resolve({ ok: false, error: 'timeout' });
      }
    }, 12000);
  });
}
function replayOk(res: any): boolean {
  return !!(res?.ok && (res?.json?.feedbackResponses?.[0]?.isProcessed ?? true));
}

// --- button rendering ---
function renderButton(action: 'nah' | 'hate-channel'): void {
  const btn = buttons[action];
  const s = state[action];
  if (!btn) return;
  if (s.activeId) {
    btn.disabled = false;
    btn.dataset.state = 'sent';
    btn.textContent = SENT_LABELS[action];
    btn.title = 'Click to undo.';
  } else if (s.token) {
    btn.disabled = false;
    btn.dataset.state = 'ready';
    btn.textContent = LABELS[action];
    btn.title = action === 'nah' ? NAH_TIP : HATE_TIP;
  } else {
    // Stay clickable so a click can explain WHY it's unavailable (toast).
    btn.disabled = false;
    btn.dataset.state = 'disabled';
    btn.textContent = LABELS[action];
    btn.title = action === 'nah' ? NAH_UNAVAIL : HATE_UNAVAIL;
  }
}

function showError(action: 'nah' | 'hate-channel', status?: number): void {
  const btn = buttons[action];
  btn.dataset.state = 'error';
  btn.textContent = 'Failed';
  btn.title = `Token rejected (status ${status ?? '?'}). Browse to recapture a fresh one.`;
  setTimeout(() => renderButton(action), 3500);
}

async function onToggle(action: 'nah' | 'hate-channel'): Promise<void> {
  const s = state[action];
  const btn = buttons[action];
  if (s.activeId) {
    // toggle OFF (undo)
    if (!s.activeUndoToken) return;
    btn.disabled = true;
    btn.dataset.state = 'loading';
    btn.textContent = 'Undoing…';
    const res = await replay(s.activeUndoToken, 'undo');
    if (replayOk(res)) {
      await chrome.runtime.sendMessage({ type: 'SYF_MARK_UNDONE', id: s.activeId } as SyfMessage);
      console.log(TAG, action, 'undone');
    }
    await refreshAvailability();
  } else if (s.token) {
    // toggle ON (apply)
    btn.disabled = true;
    btn.dataset.state = 'loading';
    btn.textContent = 'Sending…';
    const res = await replay(s.token, 'apply');
    if (!replayOk(res)) {
      showError(action, res?.status);
      return;
    }
    await chrome.runtime.sendMessage({
      type: 'SYF_LOG_ACTION',
      entry: {
        type: action === 'nah' ? 'notInterested' : 'dontRecommendChannel',
        source: 'app',
        videoId: current.videoId,
        channelId: current.channelId,
        title: current.title,
        channelName: current.channelName,
        actionToken: s.token,
        undoToken: s.undoToken,
      },
    } as SyfMessage);
    console.log(TAG, action, 'submitted');
    await refreshAvailability();
  }
}

function onClick(action: string): void {
  if (action === 'info') {
    void openLog();
    return;
  }
  if (action === 'nah' || action === 'hate-channel') {
    const s = state[action];
    if (s.activeId || s.token) void onToggle(action);
    else showToast(action === 'nah' ? NAH_REASON : HATE_REASON);
    return;
  }
  if (action === 'wipe') {
    openWipe();
    return;
  }
  if (action === 'find-comments') {
    if (!settings.apiKey) {
      showToast('A YouTube Data API key is needed to search comments — opening settings…');
      chrome.runtime?.sendMessage?.({ type: 'SYF_OPEN_OPTIONS' } as SyfMessage).catch(() => {});
    } else {
      showToast('Comment search is coming soon (your API key is set).');
    }
    return;
  }
  console.log(TAG, 'click:', action, '(not wired yet)');
}

function buildBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.className = 'syf-bar';

  const brand = document.createElement('span');
  brand.className = 'syf-brand';
  brand.textContent = 'Seth’s YouTube Fixer';
  bar.appendChild(brand);

  for (const def of BUTTONS) {
    const btn = document.createElement('button');
    btn.className = 'syf-btn';
    btn.dataset.action = def.action;
    btn.textContent = def.label;
    btn.title = def.tip;
    btn.disabled = false; // clickable; availability is conveyed via data-state
    btn.dataset.state = def.action === 'info' || def.action === 'wipe' ? 'ready' : 'disabled';
    btn.addEventListener('click', () => onClick(def.action));
    bar.appendChild(btn);
    buttons[def.action] = btn;
  }
  return bar;
}

function findMount(): HTMLElement | null {
  for (const s of ['ytd-watch-metadata', '#above-the-fold', '#primary-inner']) {
    const el = document.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
}

async function refreshAvailability(): Promise<void> {
  const videoId = getVideoId();
  if (!buttons['nah'] || !buttons['hate-channel']) return;
  if (!videoId) {
    state.nah = {};
    state['hate-channel'] = {};
    renderButton('nah');
    renderButton('hate-channel');
    return;
  }
  try {
    const r = (await chrome.runtime.sendMessage({
      type: 'SYF_LOOKUP',
      videoId,
      channelId: current.channelId,
    } as SyfMessage)) as LookupResult | undefined;
    state.nah = {
      token: r?.nahToken,
      undoToken: r?.nahUndoToken,
      activeId: r?.nahActive?.id,
      activeUndoToken: r?.nahActive?.undoToken,
    };
    state['hate-channel'] = {
      token: r?.hateToken,
      undoToken: r?.hateUndoToken,
      activeId: r?.hateActive?.id,
      activeUndoToken: r?.hateActive?.undoToken,
    };
    renderButton('nah');
    renderButton('hate-channel');
  } catch {
    /* SW waking; next schedule() retries */
  }
}

function ensureBar(): void {
  const videoId = getVideoId();
  if (!videoId) {
    document.getElementById(BAR_ID)?.remove();
    current = {};
    return;
  }
  if (videoId !== current.videoId) current = { videoId };

  if (!document.getElementById(BAR_ID)) {
    const mount = findMount();
    if (!mount) return;
    mount.prepend(buildBar());
    console.log(TAG, 'bar injected for video', videoId);
    chrome.runtime?.sendMessage?.({ type: 'SYF_INJECTED', videoId } as SyfMessage).catch(() => {});
  }
  void refreshAvailability();
}

// --- action-log panel ---
async function openLog(): Promise<void> {
  closeLog();
  const res = (await chrome.runtime.sendMessage({ type: 'SYF_GET_LOG' } as SyfMessage)) as LogResult | undefined;
  const log = res?.log ?? [];

  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'syf-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeLog();
  });

  const panel = document.createElement('div');
  panel.className = 'syf-modal-panel';
  panel.innerHTML = `<div class="syf-modal-head"><strong>Seth’s YouTube Fixer — action log</strong>
    <button class="syf-modal-close" title="Close">✕</button></div>`;
  panel.querySelector('.syf-modal-close')!.addEventListener('click', closeLog);

  const list = document.createElement('div');
  list.className = 'syf-modal-list';
  if (!log.length) {
    list.innerHTML = `<div class="syf-empty">No actions yet. Use Nah / Hate this channel, or YouTube’s own “Not interested” / “Don’t recommend channel”.</div>`;
  } else {
    for (const entry of log) list.appendChild(renderLogRow(entry));
  }
  panel.appendChild(list);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function closeLog(): void {
  document.getElementById(MODAL_ID)?.remove();
}

function renderLogRow(entry: ActionLogEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'syf-row' + (entry.undone ? ' syf-undone' : '');
  const typeLabel = entry.type === 'notInterested' ? 'Not interested' : 'Don’t recommend channel';
  const when = new Date(entry.ts).toLocaleString();
  const title = entry.title || entry.channelName || entry.videoId || '(unknown)';
  row.innerHTML = `<div class="syf-row-meta">
      <div class="syf-row-title">${escapeHtml(title)}</div>
      <div class="syf-row-sub">${typeLabel} · <span class="syf-src syf-src-${entry.source}">${entry.source}</span> · ${escapeHtml(when)}${entry.undone ? ' · <em>undone</em>' : ''}</div>
    </div>`;

  const btn = document.createElement('button');
  btn.className = 'syf-row-btn';
  if (!entry.undone && entry.undoToken) {
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => void logUndo(entry));
  } else if (entry.undone && entry.actionToken) {
    btn.textContent = 'Redo';
    btn.addEventListener('click', () => void logRedo(entry));
  } else {
    btn.style.visibility = 'hidden';
  }
  row.appendChild(btn);
  return row;
}

async function logUndo(entry: ActionLogEntry): Promise<void> {
  if (!entry.undoToken) return;
  const res = await replay(entry.undoToken, 'undo');
  if (replayOk(res)) {
    await chrome.runtime.sendMessage({ type: 'SYF_MARK_UNDONE', id: entry.id } as SyfMessage);
    await openLog();
    void refreshAvailability();
  }
}

async function logRedo(entry: ActionLogEntry): Promise<void> {
  if (!entry.actionToken) return;
  const res = await replay(entry.actionToken, 'apply');
  if (replayOk(res)) {
    await chrome.runtime.sendMessage({
      type: 'SYF_LOG_ACTION',
      entry: {
        type: entry.type,
        source: 'app',
        videoId: entry.videoId,
        channelId: entry.channelId,
        title: entry.title,
        channelName: entry.channelName,
        actionToken: entry.actionToken,
        undoToken: entry.undoToken,
      },
    } as SyfMessage);
    await openLog();
    void refreshAvailability();
  }
}

// --- Wipe history (Feature 2) ---
const WIPE_PRESETS = [15, 30, 60, 120];
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function closeWipe(): void {
  document.getElementById('syf-wipe')?.remove();
}

function openWipe(): void {
  closeWipe();
  const overlay = document.createElement('div');
  overlay.id = 'syf-wipe';
  overlay.className = 'syf-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeWipe();
  });
  const panel = document.createElement('div');
  panel.className = 'syf-modal-panel';
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  renderWipePick(panel);
}

function renderWipePick(panel: HTMLElement): void {
  panel.innerHTML = `
    <div class="syf-modal-head"><strong>Wipe recent YouTube activity</strong><button class="syf-modal-close" title="Close">✕</button></div>
    <div class="syf-wipe-body">
      <p class="syf-wipe-note">Deletes <b>all</b> YouTube activity (watches &amp; searches) in the chosen window from your Google account via My Activity. This affects your account — not just this browser — and <b>can’t be undone</b>.</p>
      <div class="syf-wipe-presets">
        ${WIPE_PRESETS.map((m) => `<button class="syf-btn syf-wipe-preset" data-min="${m}">Last ${m} min</button>`).join('')}
        <span class="syf-wipe-custom"><input id="syf-wipe-cmin" type="number" min="1" max="1440" placeholder="custom" /> min</span>
      </div>
    </div>`;
  panel.querySelector('.syf-modal-close')!.addEventListener('click', closeWipe);
  panel.querySelectorAll('.syf-wipe-preset').forEach((b) =>
    b.addEventListener('click', () => void startWipeScan(panel, Number((b as HTMLElement).dataset.min)))
  );
  const cmin = panel.querySelector('#syf-wipe-cmin') as HTMLInputElement;
  cmin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && Number(cmin.value) > 0) void startWipeScan(panel, Number(cmin.value));
  });
}

async function startWipeScan(panel: HTMLElement, minutes: number): Promise<void> {
  const body = panel.querySelector('.syf-wipe-body') as HTMLElement;
  body.innerHTML = `<div class="syf-wipe-loading">Scanning My Activity for the last ${minutes} min…</div>`;
  const endMs = Date.now();
  const startMs = endMs - minutes * 60_000;
  const res = await chrome.runtime.sendMessage({ type: 'SYF_WIPE', mode: 'scan', startMs, endMs } as SyfMessage);
  renderWipeReview(body, startMs, endMs, res);
}

function renderWipeReview(body: HTMLElement, startMs: number, endMs: number, res: any): void {
  if (!res?.ok) {
    body.innerHTML = `<div class="syf-wipe-error">Scan failed: ${escapeHtml(res?.error || 'unknown')}.<br/>Make sure you’re signed into Google in this browser.</div>`;
    return;
  }
  const matched: any[] = res.matched || [];
  if (!matched.length) {
    body.innerHTML = `<div class="syf-wipe-loading">No YouTube activity found between <b>${fmtTime(startMs)}</b> and <b>${fmtTime(endMs)}</b>.</div>`;
    return;
  }
  body.innerHTML = `
    <p class="syf-wipe-note">About to delete <b>${matched.length}</b> item(s) from <b>${fmtTime(startMs)}</b> to <b>${fmtTime(endMs)}</b>. <b>This can’t be undone.</b></p>
    <div class="syf-wipe-list">${matched
      .map((m) => `<div class="syf-wipe-item"><span class="syf-wipe-t">${escapeHtml(m.timeText)}</span> ${escapeHtml((m.title || '').slice(0, 72))}</div>`)
      .join('')}</div>
    <div class="syf-wipe-actions">
      <button class="syf-btn syf-wipe-cancel">Cancel</button>
      <button class="syf-btn syf-wipe-delete">Delete ${matched.length} item(s)</button>
    </div>`;
  body.querySelector('.syf-wipe-cancel')!.addEventListener('click', closeWipe);
  body.querySelector('.syf-wipe-delete')!.addEventListener('click', () => void doWipeDelete(body, startMs, endMs));
}

async function doWipeDelete(body: HTMLElement, startMs: number, endMs: number): Promise<void> {
  body.innerHTML = `<div class="syf-wipe-loading">Deleting via My Activity (background tab)…</div>`;
  const res = await chrome.runtime.sendMessage({ type: 'SYF_WIPE', mode: 'delete', startMs, endMs } as SyfMessage);
  if (res?.ok) {
    const remain = res.matched?.length ? ` <em>${res.matched.length} still match — re-run to retry.</em>` : '';
    body.innerHTML = `<div class="syf-wipe-done">✓ Deleted ${res.deleted ?? 0} item(s) from ${fmtTime(startMs)} to ${fmtTime(endMs)}.${remain}</div>`;
  } else {
    body.innerHTML = `<div class="syf-wipe-error">Delete failed: ${escapeHtml(res?.error || 'unknown')}.</div>`;
  }
}

// --- messages from the MAIN-world bridge ---
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.__syf !== true || d.dir !== 'from-page') return;
  switch (d.type) {
    case 'CAPTURE':
      chrome.runtime?.sendMessage?.({ type: 'SYF_CAPTURE', items: d.items } as SyfMessage).catch(() => {});
      break;
    case 'WATCH_CONTEXT':
      current = { videoId: d.videoId, channelId: d.channelId, channelName: d.channelName, title: d.title };
      void refreshAvailability();
      break;
    case 'REPLAY_RESULT': {
      const resolve = d.requestId && pending.get(d.requestId);
      if (resolve) {
        pending.delete(d.requestId);
        resolve(d.result);
      }
      break;
    }
    case 'NATIVE_ACTION': {
      const i = d.info || {};
      chrome.runtime
        ?.sendMessage?.({
          type: 'SYF_LOG_ACTION',
          entry: {
            type: i.type,
            source: 'native',
            videoId: i.videoId,
            channelId: i.channelId,
            title: i.title,
            channelName: i.channelName,
            actionToken: i.actionToken,
            undoToken: i.undoToken,
          },
        } as SyfMessage)
        .catch(() => {});
      console.log(TAG, 'native action captured:', i.type, i.videoId || i.channelId);
      setTimeout(() => void refreshAvailability(), 500);
      break;
    }
    case 'NATIVE_UNDO': {
      const i = d.info || {};
      chrome.runtime
        ?.sendMessage?.({
          type: 'SYF_MARK_UNDONE',
          match: { type: i.type, videoId: i.videoId, channelId: i.channelId },
        } as SyfMessage)
        .catch(() => {});
      setTimeout(() => void refreshAvailability(), 500);
      break;
    }
  }
});

// Relayed feedback submission from the standalone log page (via the SW).
chrome.runtime.onMessage.addListener((msg: SyfMessage, _sender, sendResponse) => {
  if (msg?.type === 'SYF_DO_REPLAY') {
    replay(msg.token, 'apply').then((result) => sendResponse(result));
    return true; // async
  }
  return false;
});

// --- SPA-aware scheduling ---
let scheduled = false;
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    ensureBar();
  });
}

const observer = new MutationObserver(() => schedule());
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('yt-navigate-finish', schedule);
document.addEventListener('yt-navigate-finish', schedule);
window.addEventListener('yt-page-data-updated', schedule);
setInterval(schedule, 3000);
schedule();
