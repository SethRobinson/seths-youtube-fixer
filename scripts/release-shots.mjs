// Release-prep harness run.
//  Part 1 — pick a video whose TOTAL comments+replies is moderate (so a full "Replies too"
//           scan actually COMPLETES → "Done — N scanned"), capture that as the headline
//           "Find in comments" screenshot, and validate the now-DYNAMIC iframe header-strip
//           rule (DNR ruleset enabled only while the window is open; bottom pane frames the
//           real signed-in watch page).
//  Part 2 — validate that feedback submission still works after moving it out of the MAIN-world
//           bridge into the isolated content script: apply "Not interested" then undo (net-zero)
//           via the button UI.
import { connect, reloadExtension, findExtensionId } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const { browser, context } = await connect();
await reloadExtension(context);
await wait(2500);
const id = await findExtensionId(context);
console.log('ext id:', id);

const swEval = async (fn) => {
  const sw = context.serviceWorkers().find((s) => s.url().startsWith(`chrome-extension://${id}`));
  if (!sw) return 'no-sw';
  return await sw.evaluate(fn).catch((e) => 'err:' + e);
};

// --- read the API key from the extension, then find a moderate-comment video via the API ---
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`, { waitUntil: 'domcontentloaded' });
const key = await ext.evaluate(() => chrome.storage.local.get('syf.settings').then((o) => o['syf.settings']?.apiKey || ''));
console.log('api key present:', !!key);
if (!key) { console.error('No API key in the test profile — cannot do comment search.'); await browser.close(); process.exit(1); }

const GAPI = 'https://www.googleapis.com/youtube/v3';
async function jget(url) { const r = await fetch(url); return r.json(); }
// A wholesome, on-brand game-devlog video with a moderate (~7.5k) comment count, so a full
// "Replies too" scan COMPLETES ("Done — N scanned") in a couple of minutes — exactly what the
// screenshot should show. (Override with SYF_SHOT_VID=<id> if its comments ever change.)
const VIDEO = process.env.SYF_SHOT_VID || 'gnxnmw5ryhg';
const info = await jget(`${GAPI}/videos?part=statistics,snippet&id=${VIDEO}&key=${key}`);
const it0 = info.items?.[0];
const pick = { vid: VIDEO, count: +(it0?.statistics?.commentCount || 0), title: it0?.snippet?.title || '' };
console.log(`video ${pick.vid} — ${pick.count} comments — "${pick.title.slice(0, 60)}"`);

// ----------------------------------------------------------- Part 1: screenshot + iframe rule
console.log('\nDNR rulesets BEFORE opening window:', JSON.stringify(await swEval(() => chrome.declarativeNetRequest.getEnabledRulesets())), '(expect [])');

const w = await context.newPage();
await w.goto(`https://www.youtube.com/watch?v=${pick.vid}`, { waitUntil: 'domcontentloaded' });
const fc = '#syf-bar [data-action="find-comments"]';
await w.waitForSelector(fc, { timeout: 30000 });
await w.locator(fc).click();

let sp = null;
for (let i = 0; i < 40 && !sp; i++) { await wait(250); sp = context.pages().find((p) => p.url().includes('comments/search.html')); }
if (!sp) { console.error('FAIL: search window did not open'); await browser.close(); process.exit(1); }
await sp.bringToFront();
await sp.waitForSelector('#cs-q', { timeout: 5000 });
await wait(800);
console.log('DNR rulesets AFTER opening window :', JSON.stringify(await swEval(() => chrome.declarativeNetRequest.getEnabledRulesets())), '(expect ["syf_iframe"])');

await sp.locator('#cs-replies').check(); // search sub-comments too

async function runTerm(term, timeoutMs) {
  await sp.fill('#cs-q', term);
  await sp.locator('#cs-go').click();
  await sp
    .waitForFunction(() => { const el = document.querySelector('#cs-status'); return el && /^(Done|Paused|Stopped|No comments)/.test((el.textContent || '').trim()); }, { timeout: timeoutMs })
    .catch(() => {});
  await wait(400);
  return { status: norm(await sp.locator('#cs-status').textContent()), rows: await sp.locator('.cs-row').count() };
}

// First term drives the real full scan (to completion). Later terms re-filter the cache (0 API calls).
const TERMS = ['love', 'great', 'amazing', 'thank', 'awesome', 'best'];
let best = { term: TERMS[0], ...(await runTerm(TERMS[0], 480000)) };
console.log(`scan "${best.term}": rows=${best.rows} | ${best.status}`);
for (const alt of TERMS.slice(1)) {
  if (best.rows >= 12) break;
  const r = await runTerm(alt, 60000);
  console.log(`re-filter "${alt}": rows=${r.rows} | ${r.status}`);
  if (r.rows > best.rows) best = { term: alt, ...r };
}
if (norm(await sp.locator('#cs-q').inputValue()) !== best.term) best = { term: best.term, ...(await runTerm(best.term, 60000)) };
console.log(`CHOSEN "${best.term}": rows=${best.rows} | ${best.status}`);
await sp.evaluate(() => document.getElementById('cs-list')?.scrollTo(0, 0));
await wait(300);
await sp.screenshot({ path: 'test-results/comment-search-window.png' });
console.log('saved test-results/comment-search-window.png');

if (best.rows > 0) {
  // Click a TOP-LEVEL comment match (no "reply" badge) so the bottom pane shows it clearly.
  const topRows = sp.locator('.cs-row').filter({ hasNot: sp.locator('.cs-badge') });
  const target = (await topRows.count()) ? topRows.first() : sp.locator('.cs-row').first();
  await target.click();
  await wait(15000); // let the framed page load + embed.ts center the highlighted comment
  const src = (await sp.locator('#cs-frame').getAttribute('src')) || '';
  const ytFrame = sp.frames().find((f) => /youtube\.com\/watch/.test(f.url()));
  let info = {};
  if (ytFrame)
    info = await ytFrame
      .evaluate(() => {
        const h = document.querySelector('ytd-comment-view-model[linked], ytd-comment-thread-renderer[linked], #comments [highlighted]');
        const topFrac = h ? Math.round((h.getBoundingClientRect().top / window.innerHeight) * 100) / 100 : null;
        return { signedIn: !!document.querySelector('#avatar-btn, #masthead img'), highlighted: !!h, highlightTopFrac: topFrac, threads: document.querySelectorAll('ytd-comment-thread-renderer').length };
      })
      .catch(() => ({}));
  const framed = !!ytFrame && (info.threads || 0) > 0;
  const shown = info.highlighted && info.highlightTopFrac != null && info.highlightTopFrac > -0.1 && info.highlightTopFrac < 0.85;
  console.log(`IFRAME: framed=${framed} lcInSrc=${/[?&]lc=/.test(src)} ${JSON.stringify(info)}`);
  console.log(framed ? '  ✓ dynamic header-strip rule works (real page framed + signed in)' : '  ✗ frame did NOT load');
  console.log(shown ? '  ✓ clicked comment is highlighted and visible in the bottom pane' : '  ✗ highlighted comment NOT clearly visible');
  await sp.screenshot({ path: 'test-results/comment-search-bottom.png' });
  console.log('saved test-results/comment-search-bottom.png');
}

// Close the search window → ruleset should turn back off.
await sp.close();
await wait(1200);
console.log('DNR rulesets AFTER closing window :', JSON.stringify(await swEval(() => chrome.declarativeNetRequest.getEnabledRulesets())), '(expect [])');

// ----------------------------------------------------------- Part 2: feedback submit moved to isolated world
console.log('\n--- validating feedback apply/undo (isolated-world submit) ---');
await ext.evaluate(() => chrome.storage.local.remove(['syf.feedback', 'syf.actionlog']));
const home = await context.newPage();
await home.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await home.waitForTimeout(4000);
for (let i = 0; i < 5; i++) { await home.mouse.wheel(0, 4000); await home.waitForTimeout(1200); }
await home.waitForTimeout(1500);
const cache = await ext.evaluate(() => chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null));
const v = cache && Object.values(cache.videos).find((x) => x.notInterested?.undoToken);
if (!v) {
  console.log('Part 2 SKIPPED: no captured Not-interested+undo token this run.');
} else {
  console.log(`toggle video ${v.videoId} "${(v.title || '').slice(0, 40)}"`);
  const t = await context.newPage();
  t.on('console', (m) => { if (m.text().includes('[SYF')) console.log('PAGE:', m.text()); });
  await t.goto(`https://www.youtube.com/watch?v=${v.videoId}`, { waitUntil: 'domcontentloaded' });
  const nah = t.locator('#syf-bar [data-action="nah"]');
  await nah.waitFor({ state: 'visible', timeout: 30000 });
  await t.waitForFunction(() => document.querySelector('#syf-bar [data-action="nah"]')?.dataset.state === 'ready', { timeout: 20000 }).catch(() => {});
  await nah.click();
  const applied = await t.waitForFunction(() => document.querySelector('#syf-bar [data-action="nah"]')?.dataset.state === 'sent', { timeout: 15000 }).then(() => true).catch(() => false);
  console.log(`APPLY → sent: ${applied ? '✓' : '✗'}`);
  await wait(800);
  await nah.click();
  const undone = await t.waitForFunction(() => document.querySelector('#syf-bar [data-action="nah"]')?.dataset.state === 'ready', { timeout: 15000 }).then(() => true).catch(() => false);
  console.log(`UNDO  → ready: ${undone ? '✓' : '✗'}`);
  console.log(applied && undone ? '  ✓ isolated-world feedback submit works (apply + undo)' : '  ✗ feedback path regressed');
}

await browser.close();
console.log('\ndone.');
