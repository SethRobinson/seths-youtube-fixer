// Isolated-world content script: injects the button bar, forwards captures from
// the MAIN-world bridge to the service worker, and reflects feedback availability
// on the watch page. Nah / Hate clicks are DRY-RUN for now (nothing is submitted).
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

const buttons: Record<string, HTMLButtonElement> = {};
let current: { videoId?: string; channelId?: string; channelName?: string; title?: string } = {};

function getVideoId(): string | null {
  const u = new URL(location.href);
  return u.pathname === '/watch' ? u.searchParams.get('v') : null;
}

// --- button state helpers ---
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

function onClick(action: string): void {
  const btn = buttons[action];
  if (action === 'nah' || action === 'hate-channel') {
    // DRY RUN — capture/availability phase. Real submission lands in the next iteration.
    console.log(TAG, 'DRY-RUN: would submit', action, 'for', current);
    btn.dataset.state = 'sent';
    btn.textContent = action === 'nah' ? 'Nah ✓ (dry-run)' : 'Hated ✓ (dry-run)';
    setTimeout(() => {
      btn.dataset.state = 'ready';
      btn.textContent = action === 'nah' ? 'Nah' : 'Hate this channel';
    }, 2500);
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
    if (r?.nah) setEnabled(nah, 'Send YouTube’s real “Not interested” for this video (cached). Dry-run for now.');
    else setDisabled(nah, NAH_UNAVAIL);
    if (r?.hate) setEnabled(hate, 'Send YouTube’s real “Don’t recommend channel” (cached). Dry-run for now.');
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
  if (videoId !== current.videoId) current = { videoId }; // reset channel on video change

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

// --- messages from the MAIN-world bridge ---
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
      current = {
        videoId: d.videoId,
        channelId: d.channelId,
        channelName: d.channelName,
        title: d.title,
      };
      void refreshAvailability();
      break;
    }
  }
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
