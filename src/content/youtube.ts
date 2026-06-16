// Isolated-world content script: injects the button bar, forwards captures from
// the MAIN-world bridge to the service worker, reflects feedback availability,
// and submits real feedback (via the bridge) on click.
import type { SyfMessage, LookupResult } from '../common/messages';

const TAG = '[SYF]';
const BAR_ID = 'syf-bar';

const NAH_UNAVAIL =
  'Not available yet — this video hasn’t been seen as a recommendation card with YouTube’s real feedback action.';
const HATE_UNAVAIL =
  'YouTube hasn’t exposed a real “Don’t recommend channel” action for this creator in this session yet.';

interface BtnDef {
  action: string;
  label: string;
  tip: string;
}

const BUTTONS: BtnDef[] = [
  { action: 'nah', label: 'Nah', tip: NAH_UNAVAIL },
  { action: 'hate-channel', label: 'Hate this channel', tip: HATE_UNAVAIL },
  { action: 'wipe', label: 'Wipe history', tip: 'Delete recent YouTube activity from your Google account via My Activity.' },
  { action: 'find-comments', label: 'Find in comments', tip: 'Search all public comments and replies on this video.' },
];

const LABELS: Record<string, string> = { nah: 'Nah', 'hate-channel': 'Hate this channel' };
const SENT_LABELS: Record<string, string> = { nah: 'Nah sent ✓', 'hate-channel': 'Channel hidden ✓' };

const buttons: Record<string, HTMLButtonElement> = {};
let current: { videoId?: string; channelId?: string; channelName?: string; title?: string } = {};
let tokens: { nah?: string; hate?: string } = {};
const sentFor: { nah?: string; hate?: string } = {}; // action -> videoId already submitted

function getVideoId(): string | null {
  const u = new URL(location.href);
  return u.pathname === '/watch' ? u.searchParams.get('v') : null;
}

function setEnabled(btn: HTMLButtonElement, tip: string): void {
  btn.disabled = false;
  btn.dataset.state = 'ready';
  btn.title = tip;
}
function setDisabled(btn: HTMLButtonElement, tip: string): void {
  btn.disabled = true;
  btn.dataset.state = 'disabled';
  btn.title = tip;
}

function submit(action: 'nah' | 'hate-channel'): void {
  const token = action === 'nah' ? tokens.nah : tokens.hate;
  const btn = buttons[action];
  if (!token || !btn) return;
  btn.disabled = true;
  btn.dataset.state = 'loading';
  btn.textContent = 'Sending…';
  window.postMessage({ __syf: true, dir: 'to-page', type: 'REPLAY', action, token }, location.origin);
}

function onReplayResult(action: string, result: any): void {
  const btn = buttons[action];
  if (!btn) return;
  const processed = result?.json?.feedbackResponses?.[0]?.isProcessed;
  const ok = !!(result?.ok && (processed ?? true));
  if (ok) {
    btn.dataset.state = 'sent';
    btn.textContent = SENT_LABELS[action] ?? '✓';
    btn.disabled = true;
    btn.title = 'Submitted to YouTube.';
    if (current.videoId) sentFor[action === 'nah' ? 'nah' : 'hate'] = current.videoId;
    console.log(TAG, action, 'submitted (isProcessed:', processed, ')');
  } else {
    btn.dataset.state = 'error';
    btn.textContent = action === 'nah' ? 'Nah failed' : 'Failed';
    btn.title = `Cached token rejected (status ${result?.status ?? '?'}). Browse to recapture a fresh one.`;
    console.warn(TAG, action, 'failed', result);
    setTimeout(() => {
      btn.dataset.state = 'ready';
      btn.disabled = false;
      btn.textContent = LABELS[action];
    }, 3500);
  }
}

function onClick(action: string): void {
  if (action === 'nah' || action === 'hate-channel') {
    submit(action);
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
    btn.dataset.state = 'disabled';
    btn.textContent = def.label;
    btn.title = def.tip;
    btn.disabled = true;
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

function removeBar(): void {
  document.getElementById(BAR_ID)?.remove();
}

// Reflect an already-submitted state so frequent refreshes don't re-enable a sent button.
function showSent(action: 'nah' | 'hate-channel'): void {
  const btn = buttons[action];
  if (!btn) return;
  btn.dataset.state = 'sent';
  btn.disabled = true;
  btn.textContent = SENT_LABELS[action];
  btn.title = 'Submitted to YouTube.';
}

async function refreshAvailability(): Promise<void> {
  const videoId = getVideoId();
  const nah = buttons['nah'];
  const hate = buttons['hate-channel'];
  if (!nah || !hate) return;
  if (!videoId) {
    setDisabled(nah, NAH_UNAVAIL);
    setDisabled(hate, HATE_UNAVAIL);
    return;
  }
  try {
    const msg: SyfMessage = { type: 'SYF_LOOKUP', videoId, channelId: current.channelId };
    const r = (await chrome.runtime.sendMessage(msg)) as LookupResult | undefined;
    tokens = { nah: r?.nahToken, hate: r?.hateToken };

    if (sentFor.nah === videoId) showSent('nah');
    else if (r?.nah) setEnabled(nah, 'Send YouTube’s real “Not interested” for this video (cached).');
    else setDisabled(nah, NAH_UNAVAIL);

    if (sentFor.hate === videoId) showSent('hate-channel');
    else if (r?.hate) setEnabled(hate, 'Send YouTube’s real “Don’t recommend channel” (cached).');
    else setDisabled(hate, HATE_UNAVAIL);
  } catch {
    /* SW may be waking; next schedule() retries */
  }
}

function ensureBar(): void {
  const videoId = getVideoId();
  if (!videoId) {
    removeBar();
    current = {};
    return;
  }
  if (videoId !== current.videoId) current = { videoId };

  if (!document.getElementById(BAR_ID)) {
    const mount = findMount();
    if (!mount) return;
    mount.prepend(buildBar());
    console.log(TAG, 'bar injected for video', videoId);
    const msg: SyfMessage = { type: 'SYF_INJECTED', videoId };
    chrome.runtime?.sendMessage?.(msg).catch(() => {});
  }
  void refreshAvailability();
}

// messages from the MAIN-world bridge
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.__syf !== true || d.dir !== 'from-page') return;
  switch (d.type) {
    case 'CAPTURE': {
      const msg: SyfMessage = { type: 'SYF_CAPTURE', items: d.items };
      chrome.runtime?.sendMessage?.(msg).catch(() => {});
      break;
    }
    case 'WATCH_CONTEXT': {
      current = { videoId: d.videoId, channelId: d.channelId, channelName: d.channelName, title: d.title };
      void refreshAvailability();
      break;
    }
    case 'REPLAY_RESULT': {
      onReplayResult(d.action, d.result);
      break;
    }
  }
});

// SPA-aware scheduling
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
