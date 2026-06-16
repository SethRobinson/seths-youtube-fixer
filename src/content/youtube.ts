// Isolated-world content script: detects YouTube SPA navigation, finds the
// watch-page mount point, and injects the Seth's YouTube Fixer button bar.
// Buttons are placeholders in this iteration; per-feature wiring lands next.
import type { SyfMessage } from '../common/messages';

const TAG = '[SYF]';
const BAR_ID = 'syf-bar';

interface BtnDef {
  action: string;
  label: string;
  tip: string;
}

const BUTTONS: BtnDef[] = [
  {
    action: 'nah',
    label: 'Nah',
    tip: 'Not available yet — this video has not been seen as a recommendation card with YouTube’s real feedback action.',
  },
  {
    action: 'hate-channel',
    label: 'Hate this channel',
    tip: 'YouTube has not exposed a real “Don’t recommend channel” action for this creator in this session yet.',
  },
  {
    action: 'wipe',
    label: 'Wipe history',
    tip: 'Delete recent YouTube activity from your Google account via My Activity.',
  },
  {
    action: 'find-comments',
    label: 'Find in comments',
    tip: 'Search all public comments and replies on this video.',
  },
];

function getVideoId(): string | null {
  const u = new URL(location.href);
  if (u.pathname === '/watch') return u.searchParams.get('v');
  return null;
}

function onClick(action: string): void {
  // Per-feature behavior is wired up in later iterations.
  console.log(TAG, 'click:', action);
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
    btn.disabled = true; // placeholder until each feature is wired up
    btn.addEventListener('click', () => onClick(def.action));
    bar.appendChild(btn);
  }
  return bar;
}

function findMount(): HTMLElement | null {
  const selectors = ['ytd-watch-metadata', '#above-the-fold', '#primary-inner'];
  for (const s of selectors) {
    const el = document.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
}

function removeBar(): void {
  document.getElementById(BAR_ID)?.remove();
}

function ensureBar(): void {
  const videoId = getVideoId();
  if (!videoId) {
    removeBar();
    return;
  }
  if (document.getElementById(BAR_ID)) return;

  const mount = findMount();
  if (!mount) return;

  mount.prepend(buildBar());
  console.log(TAG, 'bar injected for video', videoId);

  const msg: SyfMessage = { type: 'SYF_INJECTED', videoId };
  chrome.runtime?.sendMessage?.(msg).catch(() => {});
}

// --- SPA-aware scheduling -------------------------------------------------
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
setInterval(schedule, 3000); // low-frequency fallback for missed mutations

schedule();
