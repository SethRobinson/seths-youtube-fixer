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
  '“Less like this” isn’t available for this video yet. YouTube only exposes a real “Not interested” action on recommendation cards — so we can only send it for videos we’ve seen as a card. Browse Home, Search, or the Up-next sidebar until this video appears there, then come back.';
const HATE_REASON =
  '“Don’t recommend channel” isn’t available yet. We haven’t captured YouTube’s real “Don’t recommend channel” action for this creator this session. Browse a few of their videos as recommendation cards (Home / Search / Up-next), then return here.';

interface BtnDef {
  action: string;
  label: string;
  tip: string;
}

const BUTTONS: BtnDef[] = [
  { action: 'nah', label: 'Less like this', tip: NAH_UNAVAIL },
  { action: 'hate-channel', label: 'Don’t recommend channel', tip: HATE_UNAVAIL },
  { action: 'pause-history', label: '⏸ Pause history', tip: 'Open YouTube’s watch-history settings to pause or resume recording.' },
  {
    action: 'wipe',
    label: 'Forget recent',
    tip: 'Forget recent YouTube activity via My Activity. You’ll review the exact list before anything is deleted.',
  },
  { action: 'find-comments', label: 'Find in comments', tip: 'Search all public comments and replies.' },
  { action: 'info', label: 'ℹ Info', tip: 'Seth’s YouTube Fixer — settings, feedback log & undo.' },
];

const LABELS: Record<string, string> = { nah: 'Less like this', 'hate-channel': 'Don’t recommend channel' };
const SENT_LABELS: Record<string, string> = { nah: 'Less like this ✓', 'hate-channel': 'Won’t recommend ✓' };

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
  const hideRecommendedPlaylists = !!(s.hideRecommendedPlaylists ?? s.hideHomePlaylists);
  document.documentElement.classList.toggle('syf-hide-shorts', !!s.hideShorts);
  document.documentElement.classList.toggle('syf-hide-recommended-playlists', hideRecommendedPlaylists);
  updateHistoryButton();
  updateFindCommentsButton();
}

// "Find in comments" is a normal (ready) button once an API key exists; it stays
// grayed (the "unavailable" look) only until a key is entered — clicking the gray
// one opens settings to add the key.
function updateFindCommentsButton(): void {
  const b = buttons['find-comments'];
  if (!b) return;
  const hasKey = !!settings.apiKey;
  b.dataset.state = hasKey ? 'ready' : 'disabled';
  b.title = hasKey
    ? 'Search all public comments and replies on this video.'
    : 'Add a YouTube Data API key (in settings) to search comments.';
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
  const res = (await chrome.runtime.sendMessage({
    type: 'SYF_HISTORY',
    action: 'toggle',
    authUser: activeAuthUser(),
    pageId: activePageId(),
  } as SyfMessage)) as
    | HistoryResult
    | undefined;
  b.disabled = false;
  b.dataset.state = 'ready';
  if (res?.ok && typeof res.paused === 'boolean') {
    settings = { ...settings, lastHistoryPaused: res.paused };
    updateHistoryButton();
    showToast(res.paused ? 'Watch history paused.' : 'Watch history resumed.');
  } else if (res?.ok) {
    // Toggle submitted, but we couldn't read the new on/off state (e.g. a
    // non-English layout where the label wasn't parsed). Report honestly rather
    // than guessing a direction; the cached label is left as-is.
    updateHistoryButton();
    showToast('Watch history toggled. Open YouTube’s History settings to confirm the new state.');
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

// --- authenticated feedback submission (POST /youtubei/v1/feedback) ---
// This used to live in the MAIN-world page bridge, where it was reachable (and forgeable)
// by any script on the page. It now runs HERE, in the isolated world: we read SAPISID from
// document.cookie (the same value the page sees — it isn't HttpOnly) and build the
// SAPISIDHASH ourselves. The page's PUBLIC innertube config (api key + client context)
// arrives via a YT_CONFIG message from the bridge. A page-world script has no way to
// trigger this, which closes the forgeable-REPLAY write primitive.
const YT_ORIGIN = 'https://www.youtube.com';
let ytConfig: {
  apiKey?: string;
  context?: unknown;
  clientName?: unknown;
  clientVersion?: unknown;
  accountId?: string;
  authUser?: string;
  pageId?: string;
} | null = null;

function getCookie(name: string): string {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
async function sha1Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sapisidHash(): Promise<string> {
  const sap = getCookie('SAPISID') || getCookie('__Secure-3PAPISID') || getCookie('__Secure-1PAPISID');
  const ts = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sap} ${YT_ORIGIN}`)}`;
}

// The bridge loads before us but ytcfg may not be populated yet, so poll for the config
// until it arrives (then stop). ytConfig persists across SPA navigations.
function requestConfig(): void {
  window.postMessage({ __syf: true, dir: 'to-page', type: 'REQUEST_CONFIG' }, location.origin);
}
let cfgTries = 0;
const cfgTimer = setInterval(() => {
  if (ytConfig || cfgTries++ > 20) clearInterval(cfgTimer);
  else requestConfig();
}, 500);
requestConfig();

// Tell the SW which account is active so it can clear stale per-account tokens on a switch
// and route helper tabs (My Activity / History) to the active account slot.
// Deduped per page so re-posted config (every SPA nav) doesn't spam the SW; an empty id (e.g.
// signed-out, or ytcfg field absent) is ignored so we behave exactly as before.
let lastReportedAccount: string | null = null;
function normalizePageId(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}

function reportAccount(accountId?: string, authUser?: string, pageId?: string): void {
  const key = `${accountId || ''}\n${authUser || ''}\n${normalizePageId(pageId)}`;
  if (!accountId || key === lastReportedAccount) return;
  lastReportedAccount = key;
  chrome.runtime?.sendMessage?.({ type: 'SYF_ACCOUNT', accountId, authUser, pageId: normalizePageId(pageId) } as SyfMessage).catch(() => {});
}

const MY_ACTIVITY_URL = 'https://myactivity.google.com/product/youtube';
function activeAuthUser(): string {
  const s = String(ytConfig?.authUser ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}
function activePageId(): string {
  return normalizePageId(ytConfig?.pageId);
}

function youtubeActivityUrl(): string {
  const pageId = activePageId();
  const u = new URL(pageId ? `https://myactivity.google.com/b/${pageId}/product/youtube` : MY_ACTIVITY_URL);
  const authUser = activeAuthUser();
  if (authUser) u.searchParams.set('authuser', authUser);
  if (pageId) u.searchParams.set('pageId', pageId);
  return u.href;
}

function youtubeActivityLink(): string {
  return `<a class="syf-activity-link" href="${youtubeActivityUrl()}" target="_blank" rel="noopener">YouTube activity</a>`;
}

async function submitFeedback(token: string): Promise<any> {
  // Give a just-loaded page a moment to deliver its config before giving up.
  for (let i = 0; i < 25 && !ytConfig?.context; i++) await new Promise((r) => setTimeout(r, 100));
  const cfg = ytConfig;
  if (!cfg?.context) return { ok: false, error: 'no-config' };
  try {
    const res = await fetch(`${YT_ORIGIN}/youtubei/v1/feedback?key=${cfg.apiKey}&prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: await sapisidHash(),
        'X-Origin': YT_ORIGIN,
        // Target the account the user is actually viewing, not a hardcoded slot 0 — otherwise a
        // multi-login user who switched accounts would submit feedback as their primary account.
        'X-Goog-AuthUser': String(cfg.authUser ?? '0'),
        'X-Youtube-Client-Name': String(cfg.clientName ?? 1),
        'X-Youtube-Client-Version': String(cfg.clientVersion ?? ''),
      },
      body: JSON.stringify({
        context: cfg.context,
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

// `mode` is unused now (kept for call-site clarity); a 12s guard keeps the UI from hanging.
function replay(token: string, _mode: 'apply' | 'undo'): Promise<any> {
  return Promise.race([
    submitFeedback(token),
    new Promise<any>((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 12000)),
  ]);
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
  panel.innerHTML = `<div class="syf-modal-head"><strong>Forget recent ${youtubeActivityLink()}</strong><button class="syf-modal-close" title="Close">✕</button></div>
    <div class="syf-wipe-body">
      <p class="syf-wipe-note">Pick how far back to forget. The next step opens in a new tab and scans ${youtubeActivityLink()}. You’ll review the exact list before anything is deleted.</p>
      <div class="syf-wipe-presets">
        ${presets.map((m) => `<button class="syf-btn syf-wipe-preset" data-min="${m}">Last ${m} min</button>`).join('')}
        <span class="syf-wipe-custom"><input id="syf-wipe-cmin" type="number" min="1" max="1440" placeholder="custom" /> min
          <button class="syf-btn" id="syf-wipe-go">Go</button></span>
      </div>
    </div>`;
  panel.querySelector('.syf-modal-close')!.addEventListener('click', () => overlay.remove());
  const open = (m: number) => {
    overlay.remove();
    chrome.runtime
      ?.sendMessage?.({
        type: 'SYF_OPEN_PAGE',
        page: 'wipe',
        minutes: m,
        authUser: activeAuthUser(),
        pageId: activePageId(),
      } as SyfMessage)
      .catch(() => {});
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
      openSettingsDialog();
    } else {
      chrome.runtime
        ?.sendMessage?.({
          type: 'SYF_OPEN_COMMENT_SEARCH',
          videoId: current.videoId || getVideoId() || '',
          title: current.title,
        } as SyfMessage)
        .catch(() => {});
    }
    return;
  }
  console.log(TAG, 'click:', action, '(not wired yet)');
}

function buildBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.className = 'syf-bar';

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
  updateFindCommentsButton();
  return bar;
}

function findMount(): HTMLElement | null {
  for (const s of ['ytd-watch-metadata', '#above-the-fold', '#primary-inner']) {
    const el = document.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
}

// Tracks the videoId we last sent a SYF_LOOKUP for, so ensureBar()'s per-tick
// schedule (MutationObserver / 3s poll / nav events) doesn't re-message the SW on
// every frame while idle/scrolling — only on a genuine video change. WATCH_CONTEXT,
// CAPTURE and NATIVE_ACTION still call refreshAvailability() directly when tokens change.
let lastRefreshedVideoId: string | null = null;

async function refreshAvailability(): Promise<void> {
  const videoId = getVideoId();
  lastRefreshedVideoId = videoId;
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
    notifyIfContextLost(); // SW waking is fine; an orphaned context is not
  }
}

// After the extension is updated/reloaded, content scripts in already-open tabs
// are orphaned — chrome.runtime calls throw "context invalidated" and the buttons
// can never light up. Detect that and tell the user to reload (instead of failing
// silently). Common in dev because of frequent reloads.
let contextLostNotified = false;
function notifyIfContextLost(): void {
  let valid = true;
  try {
    valid = !!chrome.runtime?.id;
  } catch {
    valid = false;
  }
  if (!valid && !contextLostNotified) {
    contextLostNotified = true;
    showToast('Seth’s YouTube Fixer was updated — reload this page (Ctrl+R) to reconnect. Buttons won’t work until you do.');
  }
}

function ensureBar(): void {
  const videoId = getVideoId();
  if (!videoId) {
    document.getElementById(BAR_ID)?.remove();
    current = {};
    // Off a watch page: keep observing so we re-inject when the user navigates back.
    observeForChanges();
    return;
  }
  if (videoId !== current.videoId) current = { videoId };

  if (!document.getElementById(BAR_ID)) {
    const mount = findMount();
    if (!mount) {
      // Mount not in the DOM yet (hydrating) — keep observing until it appears.
      observeForChanges();
      return;
    }
    mount.prepend(buildBar());
    console.log(TAG, 'bar injected for video', videoId);
    chrome.runtime?.sendMessage?.({ type: 'SYF_INJECTED', videoId } as SyfMessage).catch(() => {});
  }
  // Bar is present for this video. Stop the expensive whole-document observation;
  // the nav-event listeners + the 3s poll re-arm it after a navigation removes the
  // bar (see observeForChanges / schedule). Without this, every scroll-driven DOM
  // mutation kept firing schedule()/SW lookups for the whole session.
  stopObserving();
  // Only re-query the SW on a real video change, not on every schedule tick.
  if (videoId !== lastRefreshedVideoId) void refreshAvailability();
}

// The action-log panel and Forget recent panel now live in standalone extension
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
    case 'YT_CONFIG': {
      ytConfig = {
        apiKey: d.apiKey,
        context: d.context,
        clientName: d.clientName,
        clientVersion: d.clientVersion,
        accountId: d.accountId,
        authUser: d.authUser,
        pageId: d.pageId,
      };
      reportAccount(d.accountId, d.authUser, d.pageId);
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
        // Only flip a KNOWN boolean state. If paused is unknown (the non-English
        // icon fallback couldn't tell), keep it undefined so the bar shows an
        // honest "toggled" toast instead of guessing a direction.
        const known = typeof historyInfo.paused === 'boolean' ? historyInfo.paused : undefined;
        sendResponse({
          ok,
          found: true,
          paused: ok ? (known === undefined ? undefined : !known) : known,
          error: ok ? undefined : 'submit-failed',
        });
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

// The MutationObserver watches the whole document (subtree) so we notice the bar's
// mount appearing late (hydration) or YouTube removing our bar. That observation is
// expensive on a busy YouTube page, so it runs ONLY while the bar is missing:
// observeForChanges() arms it, and ensureBar() calls stopObserving() once the bar is
// in place. SPA navigations remove the bar and fire the nav events below (or the 3s
// poll), which re-arm it.
const observer = new MutationObserver(() => schedule());
let observing = false;
function observeForChanges(): void {
  if (observing) return;
  observing = true;
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
function stopObserving(): void {
  if (!observing) return;
  observing = false;
  observer.disconnect();
}
// A navigation tears down our bar; re-arm the observer so we catch the new mount as
// the page re-renders, then ensureBar() disconnects it again once the bar is in place.
function onNav(): void {
  observeForChanges();
  schedule();
}
window.addEventListener('yt-navigate-finish', onNav);
document.addEventListener('yt-navigate-finish', onNav);
window.addEventListener('yt-page-data-updated', onNav);
setInterval(schedule, 3000);
observeForChanges();
schedule();
