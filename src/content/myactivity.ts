// Content script for myactivity.google.com (YouTube history). Scans activity
// items and deletes those in a time window via My Activity's internal delete RPC
// (Adapter B) — a same-origin authenticated fetch, no fragile UI clicks.
//
// Each item is wrapped in a <c-wiz data-token data-date> whose data-token is the
// delete token; at/f.sid/bl come from the inline WIZ_global_data script.
import type { SyfMessage } from '../common/messages';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIME_RE = /\b(\d{1,2}):(\d{2})\s?(AM|PM)\b/i;
const DELETE_RPC = 'TmdDAd';

interface ScannedItem {
  title: string;
  timeText: string | null;
  ms: number | null;
  token: string | null;
  date: string | null;
}

function parseToMs(dateStr: string | null, timeText: string | null, nowMs: number): number | null {
  const m = timeText?.match(TIME_RE);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (dateStr && /^\d{8}$/.test(dateStr)) {
    return new Date(+dateStr.slice(0, 4), +dateStr.slice(4, 6) - 1, +dateStr.slice(6, 8), h, min, 0, 0).getTime();
  }
  const now = new Date(nowMs);
  let ms = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0).getTime();
  if (ms > nowMs + 60_000) ms -= 24 * 3600 * 1000;
  return ms;
}

function tokenFor(btn: Element): { token: string | null; date: string | null } {
  let cur: Element | null = btn;
  for (let i = 0; i < 12 && cur; i++) {
    if (cur.hasAttribute('data-token')) return { token: cur.getAttribute('data-token'), date: cur.getAttribute('data-date') };
    cur = cur.parentElement;
  }
  return { token: null, date: null };
}

// Walk the DOM in document order: the last time text before a delete button is
// that item's timestamp; the button's <c-wiz> ancestor holds its delete token.
function collect(): ScannedItem[] {
  const out: ScannedItem[] = [];
  const now = Date.now();
  let lastTime: string | null = null;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = tw.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const m = (node.nodeValue || '').match(TIME_RE);
      if (m) lastTime = m[0];
    } else if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BUTTON') {
      const el = node as HTMLButtonElement;
      const al = el.getAttribute('aria-label') || '';
      if (al.startsWith('Delete activity item')) {
        const { token, date } = tokenFor(el);
        out.push({ title: al.replace(/^Delete activity item\s*/, '').trim(), timeText: lastTime, ms: parseToMs(date, lastTime, now), token, date });
      }
    }
  }
  return out;
}

function inWindow(items: ScannedItem[], startMs: number, endMs: number): ScannedItem[] {
  return items.filter((i) => i.ms != null && i.ms >= startMs && i.ms <= endMs);
}
const toWire = (i: ScannedItem) => ({ title: i.title, timeText: i.timeText ?? '', ms: i.ms ?? 0 });

// Pull at / f.sid / bl out of the inline WIZ_global_data script.
function wizParam(name: string): string | null {
  for (const s of document.querySelectorAll('script')) {
    const txt = s.textContent || '';
    if (txt.includes('WIZ_global_data')) {
      const m = txt.match(new RegExp('"' + name + '":"([^"]+)"'));
      if (m) return m[1];
    }
  }
  return null;
}

async function rpcDelete(token: string, at: string, fsid: string, bl: string): Promise<boolean> {
  const params = new URLSearchParams({
    rpcids: DELETE_RPC,
    'source-path': '/product/youtube',
    'f.sid': fsid,
    bl,
    hl: 'en',
    'soc-app': '712',
    'soc-platform': '1',
    'soc-device': '1',
    _reqid: String(Math.floor(Math.random() * 1_000_000)),
    rt: 'c',
  });
  const inner = JSON.stringify([[null, ['youtube']], [token]]);
  const freq = JSON.stringify([[[DELETE_RPC, inner, null, 'generic']]]);
  const body = `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(at)}&`;
  try {
    const res = await fetch(`https://myactivity.google.com/_/FootprintsMyactivityUi/data/batchexecute?${params}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    });
    if (!res.ok) return false;
    const text = await res.text();
    return text.includes(DELETE_RPC);
  } catch {
    return false;
  }
}

async function deleteInWindow(startMs: number, endMs: number): Promise<number> {
  const at = wizParam('SNlM0e');
  const fsid = wizParam('FdrFJe');
  const bl = wizParam('cfb2h');
  if (!at || !fsid || !bl) {
    console.warn('[SYF] missing WIZ params; cannot delete', { at: !!at, fsid: !!fsid, bl: !!bl });
    return 0;
  }
  // Collect tokens up front (the DOM doesn't auto-remove deleted rows).
  const items = inWindow(collect(), startMs, endMs).filter((i) => i.token);
  const seen = new Set<string>();
  let deleted = 0;
  for (const it of items) {
    if (seen.has(it.token!)) continue;
    seen.add(it.token!);
    if (await rpcDelete(it.token!, at, fsid, bl)) deleted++;
    await wait(160);
  }
  return deleted;
}

chrome.runtime.onMessage.addListener((msg: SyfMessage, _sender, sendResponse) => {
  if (msg?.type === 'SYF_MA_SCAN') {
    sendResponse({ ok: true, mode: 'scan', matched: inWindow(collect(), msg.startMs, msg.endMs).map(toWire) });
    return false;
  }
  if (msg?.type === 'SYF_MA_DELETE') {
    deleteInWindow(msg.startMs, msg.endMs).then((deleted) => sendResponse({ ok: true, mode: 'delete', deleted, matched: [] }));
    return true;
  }
  return false;
});

console.log('[SYF] My Activity content script ready');
