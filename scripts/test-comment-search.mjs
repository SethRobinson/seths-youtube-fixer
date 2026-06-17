// End-to-end smoke for "Find in comments" (two-pane window edition).
// - Verifies the bar button is NOT grayed when an API key is present.
// - Clicks it → a separate search window (comments/search.html) opens.
// - Runs a search (stops after ~1 page to stay quota-friendly).
// - If a REAL key is set in the test profile: confirms match rows render, then
//   clicks one and confirms the bottom pane frames the real YouTube comment page.
// - If no key: sets a DUMMY key to exercise the window + error path, then clears it.
import { connect, reloadExtension, findExtensionId } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(2000);

const id = await findExtensionId(context);
const optionsUrl = `chrome-extension://${id}/options/options.html`;

async function readKey() {
  const p = await context.newPage();
  await p.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
  const k = await p.evaluate(async () => (await chrome.storage.local.get('syf.settings'))['syf.settings']?.apiKey || '');
  await p.close();
  return k;
}
async function setKey(v) {
  const p = await context.newPage();
  await p.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
  await p.fill('#apiKey', v);
  await p.click('#save');
  await wait(700);
  await p.close();
}

const realKey = await readKey();
console.log('real api key present:', !!realKey);
let cleanup = false;
if (!realKey) {
  await setKey('AIzaSyDUMMY_invalid_key_for_ui_test_00000');
  cleanup = true;
}

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
const fc = '#syf-bar [data-action="find-comments"]';
await w.waitForSelector(fc, { timeout: 30000 });
console.log('find-comments button state:', await w.locator(fc).getAttribute('data-state'), '(expect "ready")');
await w.locator(fc).click();

let sp = null;
for (let i = 0; i < 40 && !sp; i++) {
  await wait(250);
  sp = context.pages().find((p) => p.url().includes('comments/search.html'));
}
console.log('search window opened:', !!sp);
if (!sp) {
  await browser.close();
  process.exit(1);
}
await sp.bringToFront();
await sp.waitForSelector('#cs-q', { timeout: 5000 });
console.log('header title:', (await sp.locator('#cs-title').textContent())?.slice(0, 60));

// quota-friendly: search a common word, then Stop after the first page
await sp.fill('#cs-q', 'the');
await sp.locator('#cs-go').click();
await wait(1500);
if (await sp.locator('#cs-stop').isVisible()) await sp.locator('#cs-stop').click();
await sp.waitForFunction(() => { const s = document.querySelector('#cs-status'); return s && !/Scanning/.test(s.textContent || ''); }, { timeout: 30000 });
await wait(400);

const status = ((await sp.locator('#cs-status').textContent()) || '').replace(/\s+/g, ' ').trim();
const rows = await sp.locator('.cs-row').count();
console.log('status:', status.slice(0, 200));
console.log('match rows:', rows);
await sp.screenshot({ path: 'test-results/comment-search-window.png' });

// window type/size (expect a normal, modestly-sized window — not a big popup)
const winInfo = await sp.evaluate(() => new Promise((r) => chrome.windows.getCurrent((w) => r({ type: w.type, width: w.width, height: w.height }))));
console.log('search window:', JSON.stringify(winInfo), '(expect type=normal)');

// clicking the thumbnail opens the video in a new window/tab
{
  const before = new Set(context.pages());
  await sp.locator('#cs-thumb').click();
  let np = null;
  for (let i = 0; i < 25 && !np; i++) { await wait(200); np = context.pages().find((p) => !before.has(p)); }
  console.log('thumb → new page:', !!np, np ? np.url().slice(0, 45) : '');
}
// clicking an author name opens that channel in a new window/tab
if (rows > 0) {
  const before = new Set(context.pages());
  await sp.locator('.cs-author').first().click();
  let np = null;
  for (let i = 0; i < 25 && !np; i++) { await wait(200); np = context.pages().find((p) => !before.has(p)); }
  console.log('author → new page:', !!np, np ? np.url().slice(0, 55) : '');
}

// draggable divider: drag up ~120px and confirm the split ratio changed
const before = await sp.evaluate(() => document.getElementById('cs-split').style.gridTemplateRows);
const d = await sp.locator('#cs-divider').boundingBox();
await sp.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
await sp.mouse.down();
await sp.mouse.move(d.x + d.width / 2, d.y - 120, { steps: 6 });
await sp.mouse.up();
const after = await sp.evaluate(() => document.getElementById('cs-split').style.gridTemplateRows);
console.log('divider drag changed layout:', before !== after, `("${after}")`);

if (rows > 0) {
  await sp.locator('.cs-row').first().click();
  await wait(13000); // let the framed page load comments + embed.js scroll to the linked one
  const frameVisible = await sp.locator('#cs-frame').isVisible();
  const src = (await sp.locator('#cs-frame').getAttribute('src')) || '';
  const ytFrame = sp.frames().find((f) => /youtube\.com\/watch/.test(f.url()));
  let info = {};
  if (ytFrame)
    info = await ytFrame
      .evaluate(() => ({
        signedIn: !!document.querySelector('#avatar-btn, #masthead img'),
        scrollY: Math.round(window.scrollY),
        threads: document.querySelectorAll('ytd-comment-thread-renderer').length,
      }))
      .catch(() => ({}));
  console.log('bottom: frameVisible=%s lcInSrc=%s ytLoaded=%s %s', frameVisible, /[?&]lc=/.test(src), !!ytFrame, JSON.stringify(info));
  console.log('  → scrolled to linked comment:', (info.scrollY || 0) > 0 && (info.threads || 0) > 0);
  await sp.screenshot({ path: 'test-results/comment-search-bottom.png' });
}

if (cleanup) {
  await setKey('');
  console.log('cleaned up dummy key');
}
await browser.close();
