// REAL, user-approved deletion test IN JAPANESE (IRREVERSIBLE). Renders My Activity
// with ?hl=ja, reviews, then deletes EXACTLY ONE item through the shipped content
// script (SYF_MA_DELETE → the real TmdDAd RPC), and confirms it's gone. Hard-gated:
// it refuses to delete unless a ±30s window isolates exactly one item, both locally
// and via a real server-side scan. Verifies by re-scanning that window after reload.
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MA = 'https://myactivity.google.com/product/youtube?hl=ja';

const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

// Close any stale My Activity tabs left by earlier recon runs.
for (const pg of context.pages()) {
  if ((pg.url() || '').includes('myactivity.google.com')) await pg.close().catch(() => {});
}

const p = await context.newPage();
const loadMA = async () => {
  await p.goto(MA, { waitUntil: 'domcontentloaded' });
  await p
    .waitForFunction(() => document.querySelectorAll('[data-token][data-date]').length > 0, { timeout: 20000 })
    .catch(() => {});
  await wait(2500);
};
await loadMA();

// The (possibly just-restarted) service worker drives chrome.tabs.sendMessage.
let sw = context.serviceWorkers().find((s) => s.url().includes('service-worker'));
if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });

// Run a content-script message against the hl=ja My Activity tab, from the SW.
async function ma(msg) {
  return sw.evaluate(async (m) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url && t.url.includes('myactivity.google.com') && t.url.includes('hl=ja'));
    if (!tab) return { error: 'no hl=ja MA tab' };
    for (let i = 0; i < 8; i++) {
      try {
        return await chrome.tabs.sendMessage(tab.id, m);
      } catch {
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    return { error: 'content script not responding' };
  }, msg);
}

const now = Date.now();
const FULL = { startMs: now - 48 * 3600_000, endMs: now + 60_000 };
const valid = (arr) => (arr || []).filter((i) => typeof i.ms === 'number' && i.ms > 0);

// 1) Review what the Japanese page parsed.
const full = await ma({ type: 'SYF_MA_SCAN', ...FULL });
const items = valid(full?.matched);
console.log(`\nJapanese My Activity scan: ${items.length} items with parsed timestamps`);
console.log(
  'most recent:',
  JSON.stringify(items.slice().sort((a, b) => b.ms - a.ms).slice(0, 5).map((i) => `${i.timeText}  ${(i.title || '').slice(0, 30)}`), null, 1)
);

// 2) Pick a SINGLE-item window: the most recent item whose ±30s neighborhood holds exactly one item.
let target = null;
for (const it of items.slice().sort((a, b) => b.ms - a.ms)) {
  const win = { startMs: it.ms - 30_000, endMs: it.ms + 30_000 };
  if (items.filter((x) => x.ms >= win.startMs && x.ms <= win.endMs).length === 1) {
    target = { it, win };
    break;
  }
}
if (!target) {
  console.log('No uniquely-isolatable item found → aborting WITHOUT deleting.');
  await browser.close();
  process.exit(1);
}
console.log(`\nTARGET (single item): "${target.it.timeText}  ${(target.it.title || '').slice(0, 50)}"`);

// 3) Gate: confirm server-side (real content-script scan) that the window is exactly one item.
const confirm = await ma({ type: 'SYF_MA_SCAN', ...target.win });
console.log(`confirm window scan: ${confirm?.matched?.length} item(s) (must be exactly 1 to proceed)`);
if ((confirm?.matched?.length || 0) !== 1) {
  console.log('Window is not exactly 1 item → aborting WITHOUT deleting.');
  await browser.close();
  process.exit(1);
}
const before = items.length;

// 4) DELETE — real & irreversible.
console.log('\n--- DELETING 1 item (REAL, approved, on the Japanese page) ---');
const del = await ma({ type: 'SYF_MA_DELETE', ...target.win });
console.log(`delete result: ok=${del?.ok} deleted=${del?.deleted} err=${del?.error || '-'}`);

// 5) Reload (the page doesn't auto-remove deleted rows) and verify the item is gone.
await wait(1500);
await loadMA();
const afterWin = await ma({ type: 'SYF_MA_SCAN', ...target.win });
const afterFull = valid((await ma({ type: 'SYF_MA_SCAN', ...FULL }))?.matched);

console.log(`\nAFTER: target window now has ${afterWin?.matched?.length} item(s)  (expect 0)`);
console.log(`AFTER: total parsed ${before} → ${afterFull.length}  (expect ~${before - 1}; total can vary with lazy-load)`);

const pass = del?.deleted === 1 && (afterWin?.matched?.length || 0) === 0;
console.log(`\n${pass ? '✅ PASS — Japanese delete works end-to-end (item gone from its window)' : '❌ CHECK — see numbers above'}\n`);

await browser.close();
