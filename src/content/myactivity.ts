// Content script for myactivity.google.com (YouTube history). Scans activity
// items, pairs each "Delete activity item" button with the timestamp that
// precedes it in document order, and (on explicit request) deletes those that
// fall in a time window. Scanning is read-only; deletion is irreversible.
import type { SyfMessage } from '../common/messages';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIME_RE = /\b(\d{1,2}):(\d{2})\s?(AM|PM)\b/i;

interface ScannedItem {
  button: HTMLButtonElement;
  title: string;
  timeText: string | null;
  ms: number | null;
}

function parseTimeToMs(timeText: string, nowMs: number): number | null {
  const m = timeText.match(TIME_RE);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  const now = new Date(nowMs);
  let ms = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0).getTime();
  if (ms > nowMs + 60_000) ms -= 24 * 3600 * 1000; // a "future" time means yesterday
  return ms;
}

// Walk the DOM in document order; the last time text seen before a delete button
// is that item's timestamp (handles both per-row and grouped-time layouts).
function collect(): ScannedItem[] {
  const out: ScannedItem[] = [];
  const now = Date.now();
  let lastTime: string | null = null;
  let lastMs: number | null = null;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = tw.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const m = (node.nodeValue || '').match(TIME_RE);
      if (m) {
        lastTime = m[0];
        lastMs = parseTimeToMs(m[0], now);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BUTTON') {
      const al = (node as HTMLButtonElement).getAttribute('aria-label') || '';
      if (al.startsWith('Delete activity item')) {
        out.push({
          button: node as HTMLButtonElement,
          title: al.replace(/^Delete activity item\s*/, '').trim(),
          timeText: lastTime,
          ms: lastMs,
        });
      }
    }
  }
  return out;
}

function inWindow(items: ScannedItem[], startMs: number, endMs: number): ScannedItem[] {
  return items.filter((i) => i.ms != null && i.ms >= startMs && i.ms <= endMs);
}
const toWire = (i: ScannedItem) => ({ title: i.title, timeText: i.timeText ?? '', ms: i.ms ?? 0 });

// Clicking a trash button opens a confirm dialog whose "Delete" control is NOT a
// <button> — match any clickable element whose text is exactly "Delete".
function clickConfirmDelete(): boolean {
  const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]') || document;
  const els = [...dialog.querySelectorAll('button, [role="button"], a')];
  const del = els.find((el) => (el.textContent || '').trim().toLowerCase() === 'delete');
  if (del) {
    (del as HTMLElement).click();
    return true;
  }
  return false;
}

async function deleteInWindow(startMs: number, endMs: number): Promise<number> {
  let deleted = 0;
  let stuck = 0;
  // Stop after 3 passes with no progress so a failed click can't loop forever.
  for (let pass = 0; pass < 200 && stuck < 3; pass++) {
    const before = inWindow(collect(), startMs, endMs);
    if (!before.length) break;
    before[0].button.click();
    await wait(850);
    const confirmed = clickConfirmDelete();
    await wait(confirmed ? 1000 : 350);
    const after = inWindow(collect(), startMs, endMs).length;
    if (after < before.length) {
      deleted += before.length - after;
      stuck = 0;
    } else {
      stuck++;
    }
  }
  return deleted;
}

chrome.runtime.onMessage.addListener((msg: SyfMessage, _sender, sendResponse) => {
  if (msg?.type === 'SYF_MA_SCAN') {
    sendResponse({ ok: true, mode: 'scan', matched: inWindow(collect(), msg.startMs, msg.endMs).map(toWire) });
    return false;
  }
  if (msg?.type === 'SYF_MA_DELETE') {
    deleteInWindow(msg.startMs, msg.endMs).then((deleted) => {
      sendResponse({
        ok: true,
        mode: 'delete',
        deleted,
        matched: inWindow(collect(), msg.startMs, msg.endMs).map(toWire),
      });
    });
    return true;
  }
  return false;
});

console.log('[SYF] My Activity content script ready');
