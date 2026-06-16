// Isolated-world content script: injects the button bar, forwards captures to the
// service worker, reflects availability, submits/undoes feedback (toggle), logs
// every action (incl. native YouTube actions), and shows an action-log panel.
import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  type SyfMessage,
  type LookupResult,
  type SyfSettings,
  type HistoryResult,
} from '../common/messages';

const TAG = '[SYF]';
const BAR_ID = 'syf-bar';

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
  { action: 'pause-history', label: '⏸ Pause history', tip: 'Open YouTube’s watch-history settings to pause or resume recording.' },
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
let historyInfo: { token?: string | null; paused?: boolean | null; found?: boolean } = {};

function applySettings(s: SyfSettings): void {
  settings = s;
  document.documentElement.classList.toggle('syf-hide-shorts', !!s.hideShorts);
  updateHistoryButton();
}

function updateHistoryButton(): void {
  const b = buttons['pause-history'];
  if (!b || b.dataset.state === 'loading') return; // don't stomp the "Working…" affordance
  const paused = settings.lastHistoryPaused;
  b.textContent = paused ? '▶ Resume history' : '⏸ Pause history';
  b.title = paused
    ? 'Resume YouTube watch history (start recording again).'
    : 'Pause YouTube watch history (stop recording what you watch).';
}

// "YouTube changed its code" backoff with an optional "don't show again".
const BACKOFF_MESSAGES: Record<string, string> = {
  history:
    'YouTube appears to have changed its code, so pausing watch history from here no longer works. You can still use YouTube’s own “Pause watch history” control. (Reset this from the extension settings → Reset data.)',
};
function showBackoff(key: string): void {
  if (settings.dismissedWarnings?.[key]) return;
  document.getElementById('syf-backoff')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'syf-backoff';
  overlay.className = 'syf-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = document.createElement('div');
  panel.className = 'syf-modal-panel';
  panel.innerHTML = `<div class="syf-modal-head"><strong>Heads up</strong></div>
    <div class="syf-wipe-body">
      <p class="syf-wipe-note">${BACKOFF_MESSAGES[key] || 'This feature isn’t working — YouTube may have changed its code.'}</p>
      <label class="syf-bo-check"><input type="checkbox" id="syf-bo-dont" /> Don’t show this again</label>
      <div class="syf-wipe-actions"><button class="syf-btn" id="syf-bo-ok">OK</button></div>
    </div>`;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  panel.querySelector('#syf-bo-ok')!.addEventListener('click', () => {
    if ((panel.querySelector('#syf-bo-dont') as HTMLInputElement).checked) {
      chrome.runtime
        ?.sendMessage?.({
          type: 'SYF_PATCH_SETTINGS',
          patch: { dismissedWarnings: { ...(settings.dismissedWarnings || {}), [key]: true } },
        } as SyfMessage)
        .catch(() => {});
    }
    overlay.remove();
  });
}

async function toggleHistory(): Promise<void> {
  const b = buttons['pause-history'];
  if (!b) return;
  const prev = b.textContent;
  b.disabled = true;
  b.dataset.state = 'loading';
  b.textContent = 'Working…';
  const res = (await chrome.runtime.sendMessage({ type: 'SYF_HISTORY', action: 'toggle' } as SyfMessage)) as
    | HistoryResult
    | undefined;
  b.disabled = false;
  b.dataset.state = 'ready';
  if (res?.ok && typeof res.paused === 'boolean') {
    settings = { ...settings, lastHistoryPaused: res.paused };
    updateHistoryButton();
    showToast(res.paused ? 'Watch history paused.' : 'Watch history resumed.');
  } else if (res?.error === 'no-control') {
    // Genuine: page parsed but the control is gone (YouTube changed its code).
    b.textContent = prev || '⏸ Pause history';
    showBackoff('history');
  } else {
    // Transient (slow load / signed out / submit failed) — don't cry wolf.
    b.textContent = prev || '⏸ Pause history';
    showToast('Couldn’t reach watch history (slow load or signed out?). Try again, or use YouTube’s own settings.');
  }
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

function openWipePresets(): void {
  document.getElementById('syf-wipe')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'syf-wipe';
  overlay.className = 'syf-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = document.createElement('div');
  panel.className = 'syf-modal-panel';
  const presets = settings.wipePresetsMin?.length ? settings.wipePresetsMin : [15, 30, 60, 120];
  panel.innerHTML = `<div class="syf-modal-head"><strong>Wipe recent YouTube activity</strong><button class="syf-modal-close" title="Close">✕</button></div>
    <div class="syf-wipe-body">
      <p class="syf-wipe-note">Pick how far back to delete. The next step opens in a new tab — it scans My Activity, which is slow, so it won’t interrupt your viewing here.</p>
      <div class="syf-wipe-presets">
        ${presets.map((m) => `<button class="syf-btn syf-wipe-preset" data-min="${m}">Last ${m} min</button>`).join('')}
        <span class="syf-wipe-custom"><input id="syf-wipe-cmin" type="number" min="1" max="1440" placeholder="custom" /> min
          <button class="syf-btn" id="syf-wipe-go">Go</button></span>
      </div>
    </div>`;
  panel.querySelector('.syf-modal-close')!.addEventListener('click', () => overlay.remove());
  const open = (m: number) => {
    overlay.remove();
    chrome.runtime?.sendMessage?.({ type: 'SYF_OPEN_PAGE', page: 'wipe', minutes: m } as SyfMessage).catch(() => {});
  };
  panel.querySelectorAll('.syf-wipe-preset').forEach((b) =>
    b.addEventListener('click', () => open(Number((b as HTMLElement).dataset.min)))
  );
  const cmin = panel.querySelector('#syf-wipe-cmin') as HTMLInputElement;
  const go = () => {
    const v = Number(cmin.value);
    if (v > 0) open(v);
  };
  panel.querySelector('#syf-wipe-go')!.addEventListener('click', go);
  cmin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function openSettingsDialog(): void {
  document.getElementById('syf-settings')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'syf-settings';
  overlay.className = 'syf-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const panel = document.createElement('div');
  panel.className = 'syf-modal-panel syf-settings-panel';
  panel.innerHTML = `<div class="syf-modal-head"><strong>Seth’s YouTube Fixer — settings &amp; log</strong><button class="syf-modal-close" title="Close">✕</button></div>
    <iframe class="syf-settings-iframe" src="${chrome.runtime.getURL('options/options.html')}"></iframe>`;
  panel.querySelector('.syf-modal-close')!.addEventListener('click', () => overlay.remove());
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function onClick(action: string): void {
  if (action === 'info') {
    openSettingsDialog();
    return;
  }
  if (action === 'nah' || action === 'hate-channel') {
    const s = state[action];
    if (s.activeId || s.token) void onToggle(action);
    else showToast(action === 'nah' ? NAH_REASON : HATE_REASON);
    return;
  }
  if (action === 'wipe') {
    openWipePresets();
    return;
  }
  if (action === 'pause-history') {
    void toggleHistory();
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
    btn.dataset.state = ['info', 'wipe', 'pause-history'].includes(def.action) ? 'ready' : 'disabled';
    btn.addEventListener('click', () => onClick(def.action));
    bar.appendChild(btn);
    buttons[def.action] = btn;
  }
  updateHistoryButton();
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
    case 'HISTORY_INFO':
      historyInfo = { token: d.token, paused: d.paused, found: d.found };
      break;
  }
});

// Messages from the SW: relayed feedback submission, and history toggle (this
// runs on /feed/history, where the bridge extracts the pause/resume token).
chrome.runtime.onMessage.addListener((msg: SyfMessage, _sender, sendResponse) => {
  if (msg?.type === 'SYF_DO_REPLAY') {
    replay(msg.token, 'apply').then((result) => sendResponse(result));
    return true; // async
  }
  if (msg?.type === 'SYF_HISTORY_DO') {
    if (msg.action === 'state') {
      sendResponse({ ok: historyInfo.found !== undefined, paused: historyInfo.paused, found: historyInfo.found });
      return false;
    }
    (async () => {
      // Poll until the bridge has posted HISTORY_INFO (found becomes true/false).
      for (let i = 0; i < 16 && historyInfo.found === undefined; i++) await new Promise((r) => setTimeout(r, 500));
      if (historyInfo.token) {
        const res = await replay(historyInfo.token, 'apply');
        const ok = replayOk(res);
        sendResponse({ ok, found: true, paused: ok ? !historyInfo.paused : historyInfo.paused, error: ok ? undefined : 'submit-failed' });
      } else if (historyInfo.found === false) {
        sendResponse({ ok: false, found: false, error: 'no-control' }); // parsed, control truly absent
      } else {
        sendResponse({ ok: false, error: 'timeout' }); // page never became ready
      }
    })();
    return true; // async
  }
  return false;
});

// When the user clicks a video link, capture THAT exact video immediately (from
// the current page data) so it's cached by the time we land on it — fixes the
// fast-click-from-sidebar race. Capture phase so it runs before YouTube navigates.
document.addEventListener(
  'click',
  (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href*="/watch?v="]');
    if (!a) return;
    const m = (a.getAttribute('href') || '').match(/[?&]v=([\w-]{11})/);
    if (m) window.postMessage({ __syf: true, dir: 'to-page', type: 'CAPTURE_VIDEO', videoId: m[1] }, location.origin);
  },
  true
);

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
