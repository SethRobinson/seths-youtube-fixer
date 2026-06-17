// Content script for myactivity.google.com (YouTube history). Scans activity
// items and deletes those in a time window via My Activity's internal delete RPC
// (Adapter B) — a same-origin authenticated fetch, no fragile UI clicks.
//
// Each item is wrapped in a <c-wiz data-token data-date> whose data-token is the
// delete token; at/f.sid/bl come from the inline WIZ_global_data script.
import type { SyfMessage } from '../common/messages';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELETE_RPC = 'TmdDAd';

// Localized clock formats My Activity renders per account language:
//   English 12h:  "2:30 PM"            24-hour (fr / de / es / …):  "14:30"
//   Japanese:     "午後2:30"   (午前 = AM / 午後 = PM)
//   Korean:       "오후 2:30"  (오전 = AM / 오후 = PM)
// A meridiem marker can sit before (CJK / Korean) or after (English) the H:MM.
const MERIDIEM = '(?:AM|PM|午前|午後|오전|오후)';
const MER_RE = new RegExp(MERIDIEM, 'i');
const CLOCK_RE = /(\d{1,2}):(\d{2})/;

// Pull the time-of-day out of a node. The activity timestamp sits at the START of
// its metadata line ("3:32 PM • Details" in English, "15:32 • Détails" in 24-hour
// locales, "午後3:32" / "오후 3:32" in CJK/KR), so we anchor at the start and allow
// a trailing separator. The video DURATION badge is ALSO "\d+:\d+" but lives in the
// thumbnail <a> — collect() skips anchor text so it never reaches here.
function timeTextOf(s: string): string | null {
  const m = s.trim().match(/^(?:(?:午前|午後|오전|오후)\s*)?\d{1,2}:\d{2}(?:\s*(?:AM|PM))?(?=$|[\s•·.,;])/i);
  return m ? m[0].trim() : null;
}

// Convert a localized time-of-day string to 24-hour {h, min}.
function parseTimeOfDay(s: string): { h: number; min: number } | null {
  const cm = s.match(CLOCK_RE);
  if (!cm) return null;
  let h = parseInt(cm[1], 10);
  const min = parseInt(cm[2], 10);
  if (h > 23 || min > 59) return null;
  const mer = (s.match(MER_RE)?.[0] || '').toUpperCase();
  const pm = mer === 'PM' || mer === '午後' || mer === '오후';
  const am = mer === 'AM' || mer === '午前' || mer === '오전';
  if (pm && h !== 12) h += 12; // 12h → 24h
  if (am && h === 12) h = 0;
  return { h, min };
}

interface ScannedItem {
  title: string;
  timeText: string | null;
  ms: number | null;
  token: string | null;
  date: string | null;
}

function parseToMs(dateStr: string | null, timeText: string | null, nowMs: number): number | null {
  const tod = timeText ? parseTimeOfDay(timeText) : null;
  if (!tod) return null;
  const { h, min } = tod;
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

// Best-effort human label for the review list (cosmetic — deletion keys off the
// token, never this text). English exposes it cleanly on the delete button's
// aria-label; for a localized label we can't know the prefix, so fall back to the
// activity item's own text.
function titleOf(btn: Element): string {
  const al = btn.getAttribute('aria-label') || '';
  if (al.startsWith('Delete activity item')) return al.replace(/^Delete activity item\s*/, '').trim();
  const card = btn.closest('[data-token]') || btn.parentElement;
  const txt = (card?.textContent || '').replace(/\s+/g, ' ').trim();
  return txt.slice(0, 80) || al || '(activity item)';
}

// The item's OWN timestamp: the first time-text inside its <c-wiz> container that
// isn't in the thumbnail <a> (which holds the duration badge). Preferred over the
// document-order "last time" because the delete button can sit BEFORE the item's
// own timestamp, which would otherwise mis-assign it the previous item's time.
// Returns null for items that have no inline time (they fall back to a shared group
// header via lastTime).
function ownTime(btn: Element): string | null {
  const container = btn.closest('[data-token]');
  if (!container) return null;
  const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = tw.nextNode())) {
    const pe = (n as Text).parentElement;
    if (pe && pe.closest('a')) continue; // skip the duration badge in the thumbnail
    const t = timeTextOf(n.nodeValue || '');
    if (t) return t;
  }
  return null;
}

// Walk the DOM in document order tracking the last time text (a group's shared
// header time, for items with no inline time); the button's <c-wiz> ancestor holds
// its delete token. Each item's time prefers its own inline timestamp (ownTime).
// We anchor on the token-bearing ancestor (language-independent) rather than the
// button's aria-label, which Google localizes — the old
// startsWith('Delete activity item') test found ZERO items in any non-English
// account. De-dupe by token so an item's other buttons (e.g. a localized "More
// options") don't add phantom rows; when we later meet the real English delete
// button for a token, upgrade that row's (cosmetic) title to its clean label.
function collect(): ScannedItem[] {
  const out: ScannedItem[] = [];
  const now = Date.now();
  let lastTime: string | null = null;
  const byToken = new Map<string, ScannedItem>();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = tw.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Skip text inside the thumbnail <a> — that's where the video DURATION badge
      // (also "\d+:\d+") lives, which would otherwise shadow the real timestamp.
      const inThumb = !!(node.parentElement && node.parentElement.closest('a'));
      if (!inThumb) {
        const t = timeTextOf(node.nodeValue || '');
        if (t) lastTime = t;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BUTTON') {
      const el = node as HTMLButtonElement;
      const { token, date } = tokenFor(el);
      if (!token) continue;
      const existing = byToken.get(token);
      if (existing) {
        // Prefer the real delete button's aria-label for the title when we reach it.
        if (el.getAttribute('aria-label')?.startsWith('Delete activity item')) existing.title = titleOf(el);
        continue;
      }
      const timeText = ownTime(el) ?? lastTime;
      const item: ScannedItem = { title: titleOf(el), timeText, ms: parseToMs(date, timeText, now), token, date };
      byToken.set(token, item);
      out.push(item);
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
