import type { WipeItem } from '../common/messages';

// Foreground, first-party My Activity workflow for iOS. The reviewed snapshot is
// the entire delete allowlist. Reload/background interruption never starts a delete.
export function mountActivityReview(
  collect: () => WipeItem[],
  deleteToken: (token: string) => Promise<boolean>,
  minutes: number,
): void {
  if (document.getElementById('syf-activity-review')) return;
  const host = document.createElement('div');
  host.id = 'syf-activity-review';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host { position: fixed; inset: 12px 12px auto; z-index: 2147483647; }
    section { box-sizing: border-box; max-width: 640px; max-height: 85dvh; overflow: auto; margin: auto; padding: 16px;
      background: #161616; color: #fff; border: 1px solid #777; border-radius: 16px; font: 15px/1.5 system-ui; box-shadow: 0 8px 30px #0008; }
    h2 { font-size: 19px; margin: 0 0 8px; } p { margin: 8px 0; }
    button, input { font: inherit; font-size: 16px; min-height: 44px; border: 1px solid #888; border-radius: 10px; padding: 8px; color: inherit; background: #333; box-sizing: border-box; }
    input { width: 88px; } button { cursor: pointer; } button:disabled { opacity: .5; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .danger { background: #b00020; } ol { padding-left: 24px; max-height: 34dvh; overflow: auto; }
    li { margin: 8px 0; overflow-wrap: anywhere; } output { display: block; margin: 10px 0; }
  </style><section role="dialog" aria-label="Forget recent YouTube activity">
    <h2>Forget recent</h2>
    <p>Review the loaded YouTube activity before deleting. This changes your Google account and cannot be undone.</p>
    <label>Last <input type="number" min="1" max="1440" aria-label="Minutes" /> minutes</label>
    <div class="actions"><button id="scan">Scan loaded activity</button><button id="close">Close</button></div>
    <output aria-live="polite"></output><ol></ol>
    <div class="actions"><button id="delete" class="danger" hidden>Delete reviewed items</button></div>
  </section>`;
  document.body.appendChild(host);
  const input = shadow.querySelector('input')!;
  input.value = String(Math.min(1440, Math.max(1, minutes || 15)));
  const status = shadow.querySelector('output')!;
  const list = shadow.querySelector('ol')!;
  const scan = shadow.querySelector<HTMLButtonElement>('#scan')!;
  const remove = shadow.querySelector<HTMLButtonElement>('#delete')!;
  const close = shadow.querySelector<HTMLButtonElement>('#close')!;
  let reviewed: WipeItem[] = [];
  let busy = false;
  const accountRoute = location.pathname + location.search;
  let interrupted = false;
  const onVisibility = () => { if (busy && document.hidden) interrupted = true; };
  document.addEventListener('visibilitychange', onVisibility);
  close.onclick = () => {
    if (busy) return;
    document.removeEventListener('visibilitychange', onVisibility);
    host.remove();
    history.replaceState(history.state, '', location.pathname + location.search);
  };
  const showItems = () => {
    list.replaceChildren();
    for (const item of reviewed) {
      const row = document.createElement('li');
      row.textContent = `${item.timeText} — ${item.title}`;
      list.appendChild(row);
    }
    remove.hidden = !reviewed.length;
    remove.textContent = `Delete ${reviewed.length} reviewed item(s)`;
  };
  const invalidate = () => { reviewed = []; showItems(); status.textContent = 'Scan again to review this time window.'; };
  input.addEventListener('input', invalidate);
  scan.onclick = () => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 1 || value > 1440) { status.textContent = 'Choose 1–1440 minutes.'; return; }
    const end = Date.now();
    const start = end - value * 60000;
    const seen = new Set<string>();
    reviewed = collect().filter((item) => {
      if (!item.token || seen.has(item.token) || item.ms < start || item.ms > end) return false;
      seen.add(item.token); return true;
    });
    showItems();
    status.textContent = reviewed.length
      ? `${reviewed.length} loaded item(s), ${new Date(start).toLocaleTimeString()} to ${new Date(end).toLocaleTimeString()}. Check the list, then confirm below.`
      : 'No matching loaded items. Check the account and allow My Activity to finish loading, then scan again.';
  };
  remove.onclick = async () => {
    if (busy || !reviewed.length) return;
    if (location.pathname + location.search !== accountRoute) {
      invalidate(); scan.disabled = true;
      status.textContent = 'The account page changed. Close this review and open Forget recent again.';
      return;
    }
    busy = true; interrupted = false;
    scan.disabled = remove.disabled = input.disabled = close.disabled = true;
    const snapshot = [...reviewed];
    let deleted = 0;
    let failed = false;
    try {
      for (const item of snapshot) {
        if (interrupted || document.hidden || location.pathname + location.search !== accountRoute) break;
        status.textContent = `Deleting ${deleted + 1} of ${snapshot.length}… Keep this tab visible.`;
        if (!await deleteToken(item.token!)) { failed = true; break; }
        deleted++;
        reviewed = reviewed.filter((entry) => entry.token !== item.token);
      }
    } catch { failed = true; }
    finally {
      busy = false;
      scan.disabled = remove.disabled = input.disabled = close.disabled = false;
      showItems();
      status.textContent = `${deleted} item(s) confirmed deleted. ${failed ? 'The last request could not be confirmed. Reload My Activity and scan before continuing.' : reviewed.length ? 'Stopped. Review the remaining items before continuing.' : 'Finished.'}`;
      // A failed/ambiguous request must be re-reviewed after reload, never retried automatically.
      if (failed) { remove.hidden = true; scan.disabled = true; }
    }
  };
  status.textContent = 'Once My Activity has loaded, tap Scan loaded activity. Nothing is deleted until you confirm.';
}
