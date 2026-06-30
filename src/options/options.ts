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
const hideRecommendedPlaylists = $<HTMLInputElement>('hideRecommendedPlaylists');
const savedMsg = $<HTMLDivElement>('savedMsg');
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
  hideRecommendedPlaylists.checked = !!(s.hideRecommendedPlaylists ?? s.hideHomePlaylists);
}

// Reveal/hide the API key (masked by default so it isn't shoulder-surfed).
toggleKey.addEventListener('click', () => {
  const revealing = apiKey.type === 'password';
  apiKey.type = revealing ? 'text' : 'password';
  toggleKey.textContent = revealing ? 'Hide' : 'Show';
});

// Settings auto-save the moment each field is committed (checkboxes on toggle; number/text
// fields on blur or Enter — the native `change` event), so there's no Save button to miss.
// Clamping happens on commit, not per-keystroke, so editing a number field doesn't fight you
// mid-typing and lowering the cache cap only evicts once. The SW does a serialized partial
// merge (SYF_PATCH_SETTINGS), so saving one field at a time can't clobber concurrent writers.
let savedTimer: ReturnType<typeof setTimeout> | undefined;
function flashSaved(msg = 'Saved'): void {
  savedMsg.textContent = '✓ ' + msg;
  savedMsg.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedMsg.classList.remove('show'), 1400);
}

async function patchSettings(patch: Partial<SyfSettings>): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'SYF_PATCH_SETTINGS', patch } as SyfMessage);
  flashSaved();
}

function commitTtl(): void {
  const ttl = parseFloat(ttlInput.value);
  const v = Number.isFinite(ttl) && ttl > 0 ? ttl : 7;
  ttlInput.value = String(v); // reflect the validated value back to the field
  void patchSettings({ feedbackTtlDays: v });
}

async function commitMaxVideos(): Promise<void> {
  const raw = parseInt(maxVideosInput.value, 10);
  const cap = Number.isFinite(raw) ? Math.min(Math.max(raw, MIN_CACHE_CAP), MAX_CACHE_CAP) : DEFAULT_CACHE_CAP;
  maxVideosInput.value = String(cap); // reflect the clamped value back to the field
  await patchSettings({ maxCacheVideos: cap });
  void renderCacheSize(); // lowering the cap may have evicted entries — refresh the readout
}

function commitScanCap(): void {
  const raw = parseInt(scanCapInput.value, 10);
  const scanCap = Number.isFinite(raw) ? Math.min(Math.max(raw, MIN_SCAN_CAP), MAX_SCAN_CAP) : DEFAULT_SCAN_CAP;
  scanCapInput.value = String(scanCap); // reflect the clamped value back to the field
  void patchSettings({ commentScanCap: scanCap });
}

async function commitDailyQuota(): Promise<void> {
  const raw = parseInt(dailyQuotaInput.value, 10);
  const dailyQuota = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_QUOTA;
  dailyQuotaInput.value = String(dailyQuota);
  await patchSettings({ apiDailyQuota: dailyQuota });
  void renderQuota(); // the daily-quota limit may have changed — refresh the gauge
}

function commitApiKey(): void {
  void patchSettings({ apiKey: apiKey.value.trim() });
}

hideShorts.addEventListener('change', () => void patchSettings({ hideShorts: hideShorts.checked }));
hideRecommendedPlaylists.addEventListener('change', () => void patchSettings({ hideRecommendedPlaylists: hideRecommendedPlaylists.checked }));
ttlInput.addEventListener('change', commitTtl);
maxVideosInput.addEventListener('change', () => void commitMaxVideos());
scanCapInput.addEventListener('change', commitScanCap);
dailyQuotaInput.addEventListener('change', () => void commitDailyQuota());

// The API key gets a debounced backstop on `input` in addition to commit-on-`change`, so a
// paste-then-close (closing the Info dialog without ever blurring the field) still persists.
let keyTimer: ReturnType<typeof setTimeout> | undefined;
apiKey.addEventListener('input', () => {
  clearTimeout(keyTimer);
  keyTimer = setTimeout(commitApiKey, 800);
});
apiKey.addEventListener('change', () => {
  clearTimeout(keyTimer);
  commitApiKey();
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
  flashSaved('Reset');
});

// --- action log ---
let log: ActionLogEntry[] = [];

function rowHtml(e: ActionLogEntry, i: number): string {
  const typeLabel = e.type === 'notInterested' ? 'Less like this (Not interested)' : 'Don’t recommend channel';
  const when = new Date(e.ts).toLocaleString();
  const videoUrl = e.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(e.videoId)}` : '';
  const channelUrl = e.channelId ? `https://www.youtube.com/channel/${encodeURIComponent(e.channelId)}` : '';

  // A clickable link when we have a URL to open, otherwise plain text. The title opens the
  // video; the channel name opens the channel (both in a new tab).
  const cell = (text: string, url: string, cls: string) =>
    url
      ? `<div class="${cls}"><a class="loglink" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(text)}">${esc(text)}</a></div>`
      : `<div class="${cls}">${esc(text)}</div>`;

  let rows: string;
  if (e.title || e.videoId) {
    // Normal case (a video action): title line = the video, channel line = the channel.
    rows = cell(e.title || e.videoId!, videoUrl, 'logtitle');
    if (e.channelName || e.channelId) rows += cell(e.channelName || 'View channel', channelUrl, 'logchannel');
  } else {
    // Channel-only action with no video context — promote the channel to the title line.
    rows = cell(e.channelName || '(unknown)', channelUrl, 'logtitle');
  }

  let btn = '';
  if (!e.undone && e.undoToken) btn = `<button class="logbtn" data-undo="${i}">Undo</button>`;
  else if (e.undone && e.actionToken) btn = `<button class="logbtn" data-redo="${i}">Redo</button>`;
  return `<div class="logrow ${e.undone ? 'undone' : ''}">
      <div class="logmeta">
        ${rows}
        <div class="logsub">${typeLabel} · <span class="src src-${e.source}">${esc(e.source)}</span> · ${esc(when)}${e.undone ? ' · undone' : ''}</div>
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
