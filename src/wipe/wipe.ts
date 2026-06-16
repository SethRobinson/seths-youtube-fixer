// Standalone Wipe-history page (opened in its own tab). Talks to the service
// worker (SYF_WIPE), which drives My Activity in a background tab.
import type { SyfMessage } from '../common/messages';

const root = document.getElementById('root') as HTMLDivElement;
const PRESETS = [15, 30, 60, 120];
const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function withBack(html: string): void {
  root.innerHTML = html + '<div class="actions"><button class="btn" id="back">Back</button></div>';
  root.querySelector('#back')!.addEventListener('click', renderPick);
}

function renderPick(): void {
  root.innerHTML = `
    <p class="note">Deletes <b>all</b> YouTube activity (watches &amp; searches) in the chosen window from your Google account via My Activity. This affects your account — not just this browser — and <b>can’t be undone</b>.</p>
    <div class="presets">
      ${PRESETS.map((m) => `<button class="btn preset" data-min="${m}">Last ${m} min</button>`).join('')}
      <span class="custom"><input id="cmin" type="number" min="1" max="1440" placeholder="custom" /> min
        <button class="btn" id="customGo">Scan</button></span>
    </div>`;
  root.querySelectorAll('.preset').forEach((b) =>
    b.addEventListener('click', () => void scan(Number((b as HTMLElement).dataset.min)))
  );
  const cmin = root.querySelector('#cmin') as HTMLInputElement;
  const go = () => {
    const v = Number(cmin.value);
    if (v > 0) void scan(v);
  };
  root.querySelector('#customGo')!.addEventListener('click', go);
  cmin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
}

async function scan(minutes: number): Promise<void> {
  root.innerHTML = `<div class="loading">Scanning My Activity for the last ${minutes} min… (opens My Activity in a background tab — this can take ~10s)</div>`;
  const endMs = Date.now();
  const startMs = endMs - minutes * 60_000;
  const res = await chrome.runtime.sendMessage({ type: 'SYF_WIPE', mode: 'scan', startMs, endMs } as SyfMessage);
  renderReview(startMs, endMs, res);
}

function renderReview(startMs: number, endMs: number, res: any): void {
  if (!res?.ok) {
    withBack(`<div class="error">Scan failed: ${esc(res?.error || 'unknown')}.<br/>Make sure you’re signed into Google in this browser.</div>`);
    return;
  }
  const matched: any[] = res.matched || [];
  if (!matched.length) {
    withBack(`<div class="loading">No YouTube activity found between <b>${fmtTime(startMs)}</b> and <b>${fmtTime(endMs)}</b>.</div>`);
    return;
  }
  root.innerHTML = `
    <p class="note">About to delete <b>${matched.length}</b> item(s) from <b>${fmtTime(startMs)}</b> to <b>${fmtTime(endMs)}</b>. <b>This can’t be undone.</b></p>
    <div class="list">${matched
      .map((m) => `<div class="item"><span class="t">${esc(m.timeText)}</span> ${esc((m.title || '').slice(0, 80))}</div>`)
      .join('')}</div>
    <div class="actions">
      <button class="btn" id="cancel">Cancel</button>
      <button class="btn delete" id="del">Delete ${matched.length} item(s)</button>
    </div>`;
  root.querySelector('#cancel')!.addEventListener('click', renderPick);
  root.querySelector('#del')!.addEventListener('click', () => void doDelete(startMs, endMs, matched.length));
}

async function doDelete(startMs: number, endMs: number, count: number): Promise<void> {
  root.innerHTML = `<div class="loading">Deleting ${count} item(s) via My Activity…</div>`;
  const res = await chrome.runtime.sendMessage({ type: 'SYF_WIPE', mode: 'delete', startMs, endMs } as SyfMessage);
  if (res?.ok) {
    withBack(`<div class="done">✓ Deleted ${res.deleted ?? 0} item(s) from ${fmtTime(startMs)} to ${fmtTime(endMs)}.</div>`);
  } else {
    withBack(`<div class="error">Delete failed: ${esc(res?.error || 'unknown')}.</div>`);
  }
}

renderPick();
