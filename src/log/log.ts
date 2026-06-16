// Standalone action-log page (opened in its own tab). Reads the log from the SW;
// Undo/Redo submit feedback by relaying through an open YouTube tab (SYF_RELAY_REPLAY).
import type { SyfMessage, LogResult } from '../common/messages';
import type { ActionLogEntry } from '../common/feedback';

const root = document.getElementById('root') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const setStatus = (s: string) => (statusEl.textContent = s);

let log: ActionLogEntry[] = [];

function rowHtml(e: ActionLogEntry, i: number): string {
  const typeLabel = e.type === 'notInterested' ? 'Hate content (Not interested)' : 'Hate channel (Don’t recommend)';
  const when = new Date(e.ts).toLocaleString();
  const title = e.title || e.channelName || e.videoId || '(unknown)';
  let btn = '';
  if (!e.undone && e.undoToken) btn = `<button class="rowbtn" data-undo="${i}">Undo</button>`;
  else if (e.undone && e.actionToken) btn = `<button class="rowbtn" data-redo="${i}">Redo</button>`;
  return `<div class="row ${e.undone ? 'undone' : ''}">
      <div class="meta">
        <div class="rtitle">${esc(title)}</div>
        <div class="rsub">${typeLabel} · <span class="src src-${e.source}">${e.source}</span> · ${esc(when)}${e.undone ? ' · undone' : ''}</div>
      </div>${btn}</div>`;
}

async function render(): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'SYF_GET_LOG' } as SyfMessage)) as LogResult | undefined;
  log = res?.log ?? [];
  if (!log.length) {
    root.innerHTML = `<div class="empty">No actions yet. Use Hate content / Hate channel on a video, or YouTube’s own “Not interested” / “Don’t recommend channel”.</div>`;
    return;
  }
  root.innerHTML = log.map(rowHtml).join('');
  root.querySelectorAll('[data-undo]').forEach((b) =>
    b.addEventListener('click', () => void act(log[Number((b as HTMLElement).dataset.undo)], 'undo'))
  );
  root.querySelectorAll('[data-redo]').forEach((b) =>
    b.addEventListener('click', () => void act(log[Number((b as HTMLElement).dataset.redo)], 'redo'))
  );
}

async function act(entry: ActionLogEntry, kind: 'undo' | 'redo'): Promise<void> {
  const token = kind === 'undo' ? entry.undoToken : entry.actionToken;
  if (!token) return;
  setStatus('Submitting…');
  const res: any = await chrome.runtime.sendMessage({ type: 'SYF_RELAY_REPLAY', token } as SyfMessage);
  if (res?.error === 'no-youtube-tab') {
    setStatus('Open a YouTube tab first (the request is sent through your YouTube session), then try again.');
    return;
  }
  const ok = res?.ok && (res?.json?.feedbackResponses?.[0]?.isProcessed ?? true);
  if (!ok) {
    setStatus('Failed — the cached token may have expired.');
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
  setStatus('');
  void render();
}

void render();
