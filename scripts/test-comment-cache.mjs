// Verify the in-window comment cache: a 1st search fetches (costs API calls); a 2nd
// search for a DIFFERENT word reuses the cached comments (0 new API calls).
import { connect, reloadExtension, findExtensionId } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="find-comments"]', { timeout: 30000 });
await w.locator('#syf-bar [data-action="find-comments"]').click();
let sp = null;
for (let i = 0; i < 40 && !sp; i++) { await wait(250); sp = context.pages().find((p) => p.url().includes('comments/search.html')); }
await sp.bringToFront();
await sp.waitForSelector('#cs-q', { timeout: 5000 });

const runSearch = async (q, stopEarly) => {
  await sp.fill('#cs-q', q);
  await sp.locator('#cs-go').click();
  if (stopEarly) {
    await wait(1400);
    if (await sp.locator('#cs-stop').isVisible()) await sp.locator('#cs-stop').click();
  }
  await sp.waitForFunction(() => { const s = document.querySelector('#cs-status'); return s && !/Scanning/.test(s.textContent || ''); }, { timeout: 30000 });
  await wait(300);
  return ((await sp.locator('#cs-status').textContent()) || '').replace(/\s+/g, ' ').trim();
};

// 1st search — fetches from the API (stop early to keep quota tiny)
const first = await runSearch('the', true);
console.log('1st search :', first.slice(0, 160));

// 2nd search, different word — should reuse the cache, 0 new API calls
const second = await runSearch('love', false);
console.log('2nd search :', second.slice(0, 160));

// 3rd search, yet another word — also reused
const third = await runSearch('great', false);
console.log('3rd search :', third.slice(0, 160));

const reused2 = /reused cached comments/.test(second) && /0 new API calls/.test(second);
const reused3 = /reused cached comments/.test(third) && /0 new API calls/.test(third);
console.log('RESULT: 2nd reused =', reused2, '| 3rd reused =', reused3);
await sp.screenshot({ path: 'test-results/comment-cache.png' });
await browser.close();
