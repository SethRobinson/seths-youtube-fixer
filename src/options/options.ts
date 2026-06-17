import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  DEFAULT_SCAN_CAP,
  MIN_SCAN_CAP,
  MAX_SCAN_CAP,
  DEFAULT_DAILY_QUOTA,
  type SyfSettings,
  type SyfMessage,
  type LogResult,
  type QuotaResult,
} from '../common/messages';
import {
  type ActionLogEntry,
  FEEDBACK_KEY,
  DEFAULT_CACHE_CAP,
  MIN_CACHE_CAP,
  MAX_CACHE_CAP,
  MAX_FEEDBACK_BYTES,
} from '../common/feedback';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const apiKey = $<HTMLInputElement>('apiKey');
const toggleKey = $<HTMLButtonElement>('toggleKey');
const ttlInput = $<HTMLInputElement>('ttlDays');
const maxVideosInput = $<HTMLInputElement>('maxVideos');
const scanCapInput = $<HTMLInputElement>('scanCap');
const hideShorts = $<HTMLInputElement>('hideShorts');
const savedMsg = $<HTMLSpanElement>('savedMsg');
const logEl = $<HTMLDivElement>('log');
const logStatus = $<HTMLDivElement>('logStatus');
const cacheSizeEl = $<HTMLElement>('cacheSize');
const cacheBar = $<HTMLElement>('cacheBar');
const dailyQuotaInput = $<HTMLInputElement>('dailyQuota');
const quotaText = $<HTMLElement>('quotaText');
const quotaBar = $<HTMLElement>('quotaBar');
const resetQuotaLink = $<HTMLAnchorElement>('resetQuota');

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
  maxVideosInput.min = String(MIN_CACHE_CAP);
  maxVideosInput.max = String(MAX_CACHE_CAP);
  maxVideosInput.value = String(s.maxCacheVideos ?? DEFAULT_CACHE_CAP);
  scanCapInput.min = String(MIN_SCAN_CAP);
  scanCapInput.max = String(MAX_SCAN_CAP);
  scanCapInput.value = String(s.commentScanCap ?? DEFAULT_SCAN_CAP);
  dailyQuotaInput.value = String(s.apiDailyQuota ?? DEFAULT_DAILY_QUOTA);
  hideShorts.checked = !!s.hideShorts;
}

// Reveal/hide the API key (masked by default so it isn't shoulder-surfed).
toggleKey.addEventListener('click', () => {
  const revealing = apiKey.type === 'password';
  apiKey.type = revealing ? 'text' : 'password';
  toggleKey.textContent = revealing ? 'Hide' : 'Show';
});

$<HTMLButtonElement>('save').addEventListener('click', async () => {
  const ttl = parseFloat(ttlInput.value);
  const capRaw = parseInt(maxVideosInput.value, 10);
  const cap = Number.isFinite(capRaw) ? Math.min(Math.max(capRaw, MIN_CACHE_CAP), MAX_CACHE_CAP) : DEFAULT_CACHE_CAP;
  maxVideosInput.value = String(cap); // reflect the clamped value back to the field
  const scanRaw = parseInt(scanCapInput.value, 10);
  const scanCap = Number.isFinite(scanRaw) ? Math.min(Math.max(scanRaw, MIN_SCAN_CAP), MAX_SCAN_CAP) : DEFAULT_SCAN_CAP;
  scanCapInput.value = String(scanCap); // reflect the clamped value back to the field
  const dqRaw = parseInt(dailyQuotaInput.value, 10);
  const dailyQuota = Number.isFinite(dqRaw) && dqRaw > 0 ? dqRaw : DEFAULT_DAILY_QUOTA;
  dailyQuotaInput.value = String(dailyQuota);
  // Serialized merge in the SW so we don't clobber concurrent writers.
  await chrome.runtime.sendMessage({
    type: 'SYF_PATCH_SETTINGS',
    patch: {
      apiKey: apiKey.value.trim(),
      feedbackTtlDays: Number.isFinite(ttl) && ttl > 0 ? ttl : 7,
      maxCacheVideos: cap,
      commentScanCap: scanCap,
      apiDailyQuota: dailyQuota,
      hideShorts: hideShorts.checked,
    },
  } as SyfMessage);
  savedMsg.textContent = 'Saved';
  setTimeout(() => (savedMsg.textContent = ''), 1500);
  void renderCacheSize(); // lowering the cap may have evicted entries — refresh the readout
  void renderQuota(); // the daily-quota limit may have changed — refresh the gauge
});

resetQuotaLink.addEventListener('click', async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ type: 'SYF_RESET_QUOTA' } as SyfMessage);
  void renderQuota();
});

$<HTMLButtonElement>('reset').addEventListener('click', async () => {
  if (!confirm('Delete all of this extension’s local data (feedback tokens, action log, settings)? This cannot be undone. Your YouTube account is not affected.')) {
    return;
  }
  await chrome.runtime.sendMessage({ type: 'SYF_RESET' } as SyfMessage);
  await initSettings();
  await renderLog();
  await renderCacheSize();
  await renderQuota();
  savedMsg.textContent = 'Reset';
  setTimeout(() => (savedMsg.textContent = ''), 1500);
});

// --- action log ---
let log: ActionLogEntry[] = [];

function rowHtml(e: ActionLogEntry, i: number): string {
  const typeLabel = e.type === 'notInterested' ? 'Less like this (Not interested)' : 'Don’t recommend channel';
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
    logEl.innerHTML = `<div class="empty">No actions yet. Use “Less like this” / “Don’t recommend channel” on a video, or YouTube’s own “Not interested” / “Don’t recommend channel”.</div>`;
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
    const [fbBytes, totalBytes, store, settingsStore] = await Promise.all([
      chrome.storage.local.getBytesInUse(FEEDBACK_KEY).catch(() => 0),
      chrome.storage.local.getBytesInUse(null).catch(() => 0),
      chrome.storage.local.get(FEEDBACK_KEY),
      chrome.storage.local.get(SETTINGS_KEY),
    ]);
    const fb: any = store[FEEDBACK_KEY];
    const cap = (settingsStore[SETTINGS_KEY] as SyfSettings | undefined)?.maxCacheVideos ?? DEFAULT_CACHE_CAP;
    const videos = Object.keys(fb?.videos || {}).length;
    const channels = Object.keys(fb?.channels || {}).length;
    const mb = (n: number) => (n / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 });
    cacheSizeEl.textContent = `${videos.toLocaleString()} videos · ${channels.toLocaleString()} channels · ${mb(fbBytes)} MB of ${mb(MAX_FEEDBACK_BYTES)} MB (total ${mb(totalBytes)} MB; cap ${cap.toLocaleString()} videos / ${cap.toLocaleString()} channels).`;
    cacheBar.style.width = Math.min(100, Math.max(videos / cap, channels / cap, fbBytes / MAX_FEEDBACK_BYTES) * 100) + '%';
  } catch {
    cacheSizeEl.textContent = '';
  }
}

async function renderQuota(): Promise<void> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: 'SYF_GET_QUOTA' } as SyfMessage)) as QuotaResult | undefined;
    if (!r?.ok) {
      quotaText.textContent = '';
      return;
    }
    const used = r.used;
    const limit = Math.max(1, r.limit);
    const remaining = Math.max(0, limit - used);
    const pct = Math.min(100, (used / limit) * 100);
    quotaBar.style.width = pct + '%';
    quotaBar.style.background = pct >= 90 ? '#cc0000' : pct >= 70 ? '#e8a000' : 'var(--accent)';
    quotaText.textContent = `≈ ${used.toLocaleString()} of ${limit.toLocaleString()} units used today · about ${remaining.toLocaleString()} left (estimate of this extension’s calls).`;
  } catch {
    quotaText.textContent = '';
  }
}

void initSettings();
void renderLog();
void renderCacheSize();
void renderQuota();
