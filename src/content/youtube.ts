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
    chrome.runtime?.sendMessage?.({ type: 'SYF_OPEN_PAGE', page: 'log' } as SyfMessage).catch(() => {});
    return;
  }
  if (action === 'nah' || action === 'hate-channel') {
    const s = state[action];
    if (s.activeId || s.token) void onToggle(action);
    else showToast(action === 'nah' ? NAH_REASON : HATE_REASON);
    return;
  }
  if (action === 'wipe') {
    chrome.runtime?.sendMessage?.({ type: 'SYF_OPEN_PAGE', page: 'wipe' } as SyfMessage).catch(() => {});
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

// The action-log panel and Wipe-history panel now live in standalone extension
// pages (src/log/ and src/wipe/), opened in their own tabs via SYF_OPEN_PAGE.

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
