// Seth's real scenario: while watching, repeatedly click a REAL sidebar card.
// After the first click we're in SPA mode (ytInitialData is now stale; the sidebar
// comes from /next). Click real yt-lockup/compact cards, with a realistic short
// dwell, and at each hop record: was B cached before click, button state on
// destination, lookup after, + screenshot.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DWELL = Number(process.argv[3] || 3000); // realistic-ish dwell before clicking
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));

const lookup = (v) => ext.evaluate((vid) => chrome.runtime.sendMessage({ type: 'SYF_LOOKUP', videoId: vid }), v);

const w = await context.newPage();
const net = { fetchNext: 0, xhrNext: 0 };
await w.addInitScript(() => {
  window.__n = { f: 0, x: 0 };
  const re = /\/youtubei\/v1\/next/;
  const of = window.fetch;
  window.fetch = function (...a) { try { const u = typeof a[0] === 'string' ? a[0] : a[0]?.url; if (u && re.test(u)) window.__n.f++; } catch {} return of.apply(this, a); };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { try { if (typeof u === 'string' && re.test(u)) window.__n.x++; } catch {} return oo.call(this, m, u, ...r); };
});

const SRC = process.argv[2] || 'kJQP7kiw5Fk';
await w.goto(`https://www.youtube.com/watch?v=${SRC}`, { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#secondary yt-lockup-view-model a[href*="/watch?v="], #secondary ytd-compact-video-renderer a[href*="/watch?v="]', { timeout: 15000 }).catch(() => {});

const CARD_SEL = '#secondary yt-lockup-view-model, #secondary ytd-compact-video-renderer';

async function pickFirstCard() {
  return w.evaluate((sel) => {
    const card = document.querySelector(sel);
    if (!card) return null;
    const a = card.querySelector('a[href*="/watch?v="]');
    const m = a?.href.match(/[?&]v=([\w-]{11})/);
    const t = (card.querySelector('#video-title, .yt-lockup-metadata-view-model__title, h3')?.textContent || '').trim().slice(0, 40);
    return m ? { v: m[1], title: t } : null;
  }, CARD_SEL);
}

const rows = [];
for (let hop = 1; hop <= 5; hop++) {
  await wait(DWELL);
  const card = await pickFirstCard();
  if (!card) { rows.push({ hop, err: 'no-card' }); break; }
  const before = await lookup(card.v);
  const url = w.url();
  await w.evaluate((sel) => { const a = document.querySelector(sel)?.querySelector('a[href*="/watch?v="]'); a?.click(); }, CARD_SEL);
  await w.waitForFunction((u) => location.href !== u, url, { timeout: 12000 }).catch(() => {});
  await wait(4500);
  const st = await w.evaluate(() => {
    const cur = new URL(location.href).searchParams.get('v');
    const read = (act) => { const b = document.querySelector(`#syf-bar [data-action="${act}"]`); return b ? { state: b.dataset.state, disabled: !!b.disabled } : null; };
    return { cur, nah: read('nah'), hate: read('hate-channel'), n: window.__n };
  });
  const after = await lookup(card.v);
  await w.screenshot({ path: `test-results/hop-real-${hop}-${card.v}.png` });
  rows.push({
    hop,
    clicked: card.v,
    title: card.title,
    landedOnIt: st.cur === card.v,
    cachedBefore: !!before?.nahToken,
    cachedAfter: !!after?.nahToken,
    nah: st.nah ? `${st.nah.state}${st.nah.disabled ? '/dis' : ''}` : 'none',
    hate: st.hate ? `${st.hate.state}${st.hate.disabled ? '/dis' : ''}` : 'none',
    nextFetch: st.n.f,
    nextXhr: st.n.x,
  });
}

console.table(rows);
const enabled = rows.filter((r) => r.nah && r.nah.startsWith('ready')).length;
const valid = rows.filter((r) => !r.err).length;
console.log(`Hate content ENABLED: ${enabled}/${valid}  (dwell=${DWELL}ms)`);
await browser.close();
