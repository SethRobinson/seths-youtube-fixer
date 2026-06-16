import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  type SyfSettings,
  type SyfMessage,
  type LogResult,
} from '../common/messages';
import type { ActionLogEntry } from '../common/feedback';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const apiKey = $<HTMLInputElement>('apiKey');
const ttlInput = $<HTMLInputElement>('ttlDays');
const hideShorts = $<HTMLInputElement>('hideShorts');
const savedMsg = $<HTMLSpanElement>('savedMsg');
const logEl = $<HTMLDivElement>('log');
const logStatus = $<HTMLDivElement>('logStatus');
const cacheSizeEl = $<HTMLElement>('cacheSize');
const cacheBar = $<HTMLElement>('cacheBar');

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function loadSettings(): Promise<SyfSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

async function initSettings() {
  const s = await loadSettings();
  apiKey.value = s.apiKey ?? '';
  ttlInput.value = String(s.feedbackTtlDays ?? 7);
  hideShorts.checked = !!s.hideShorts;
}

$<HTMLButtonElement>('save').addEventListener('click', async () => {
  const ttl = parseFloat(ttlInput.value);
  // Serialized merge in the SW so we don't clobber concurrent writers.
  await chrome.runtime.sendMessage({
    type: 'SYF_PATCH_SETTINGS',
    patch: {
      apiKey: apiKey.value.trim(),
      feedbackTtlDays: Number.isFinite(ttl) && ttl > 0 ? ttl : 7,
      hideShorts: hideShorts.checked,
    },
  } as SyfMessage);
  savedMsg.textContent = 'Saved';
  setTimeout(() => (savedMsg.textContent = ''), 1500);
});

$<HTMLButtonElement>('reset').addEventListener('click', async () => {
  if (!confirm('Delete all of this extension’s local data (feedback tokens, action log, settings)? This cannot be undone. Your YouTube account is not affected.')) {
    return;
  }
  await chrome.runtime.sendMessage({ type: 'SYF_RESET' } as SyfMessage);
  await initSettings();
  await renderLog();
  await renderCacheSize();
  savedMsg.textContent = 'Reset';
  setTimeout(() => (savedMsg.textContent = ''), 1500);
});

// --- action log ---
let log: ActionLogEntry[] = [];

function rowHtml(e: ActionLogEntry, i: number): string {
  const typeLabel = e.type === 'notInterested' ? 'Hate content (Not interested)' : 'Hate channel (Don’t recommend)';
  const when = new Date(e.ts).toLocaleString();
  const title = e.title || e.channelName || e.videoId || '(unknown)';
  let btn = '';
  if (!e.undone && e.undoToken) btn = `<button class="logbtn" data-undo="${i}">Undo</button>`;
  else if (e.undone && e.actionToken) btn = `<button class="logbtn" data-redo="${i}">Redo</button>`;
  return `<div class="logrow ${e.undone ? 'undone' : ''}">
      <div class="logmeta">
        <div class="logtitle">${esc(title)}</div>
        <div class="logsub">${typeLabel} · <span class="src src-${e.source}">${e.source}</span> · ${esc(when)}${e.undone ? ' · undone' : ''}</div>
      </div>${btn}</div>`;
}

async function renderLog(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'SYF_GET_LOG' } as SyfMessage)) as LogResult | undefined;
  log = res?.log ?? [];
  if (!log.length) {
    logEl.innerHTML = `<div class="empty">No actions yet. Use Hate content / Hate channel on a video, or YouTube’s own “Not interested” / “Don’t recommend channel”.</div>`;
    return;
  }
  logEl.innerHTML = log.map(rowHtml).join('');
  logEl.querySelectorAll('[data-undo]').forEach((b) =>
    b.addEventListener('click', () => void act(log[Number((b as HTMLElement).dataset.undo)], 'undo'))
  );
  logEl.querySelectorAll('[data-redo]').forEach((b) =>
    b.addEventListener('click', () => void act(log[Number((b as HTMLElement).dataset.redo)], 'redo'))
  );
}

async function act(entry: ActionLogEntry, kind: 'undo' | 'redo'): Promise<void> {
  const token = kind === 'undo' ? entry.undoToken : entry.actionToken;
  if (!token) return;
  logStatus.textContent = 'Submitting…';
  const res: any = await chrome.runtime.sendMessage({ type: 'SYF_RELAY_REPLAY', token } as SyfMessage);
  if (res?.error === 'no-youtube-tab') {
    logStatus.textContent = 'Open a YouTube tab first (the request goes through your YouTube session), then try again.';
    return;
  }
  const ok = res?.ok && (res?.json?.feedbackResponses?.[0]?.isProcessed ?? true);
  if (!ok) {
    logStatus.textContent = 'Failed — the cached token may have expired.';
    return;
  }
  if (kind === 'undo') {
    await chrome.runtime.sendMessage({ type: 'SYF_MARK_UNDONE', id: entry.id } as SyfMessage);
  } else {
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
  }
  logStatus.textContent = '';
  void renderLog();
}

async function renderCacheSize(): Promise<void> {
  try {
    const [fbBytes, totalBytes, store] = await Promise.all([
      chrome.storage.local.getBytesInUse('syf.feedback').catch(() => 0),
      chrome.storage.local.getBytesInUse(null).catch(() => 0),
      chrome.storage.local.get('syf.feedback'),
    ]);
    const fb: any = store['syf.feedback'];
    const videos = Object.keys(fb?.videos || {}).length;
    const channels = Object.keys(fb?.channels || {}).length;
    const kb = (n: number) => (n / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 });
    cacheSizeEl.textContent = `${videos.toLocaleString()} videos · ${channels.toLocaleString()} channels · ${kb(fbBytes)} KB (extension total ${kb(totalBytes)} KB, of 2,000-video cap).`;
    cacheBar.style.width = Math.min(100, (videos / 2000) * 100) + '%';
  } catch {
    cacheSizeEl.textContent = '';
  }
}

void initSettings();
void renderLog();
void renderCacheSize();
