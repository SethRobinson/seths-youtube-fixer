// With the extension running: land on a watch page, wait, and check whether the
// sidebar (up-next) videos actually get cached with their NI tokens.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);

const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await wait(8000);

const sidebarIds = await w.evaluate(() => {
  const ids = new Set();
  document
    .querySelectorAll('#secondary a[href*="/watch?v="], ytd-watch-next-secondary-results-renderer a[href*="/watch?v="]')
    .forEach((a) => {
      const m = a.href.match(/[?&]v=([\w-]{11})/);
      if (m) ids.add(m[1]);
    });
  return [...ids];
});

const cache = await ext.evaluate(() => chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null));
const videos = cache?.videos || {};
const cachedNI = new Set(Object.values(videos).filter((v) => v.notInterested).map((v) => v.videoId));
const cachedDR = new Set(Object.values(videos).filter((v) => v.dontRecommendChannel).map((v) => v.videoId));

console.log('sidebar videos in DOM:', sidebarIds.length);
console.log('cached videos total:', Object.keys(videos).length, '| withNI:', cachedNI.size);
console.log(`sidebar cached with NI: ${sidebarIds.filter((x) => cachedNI.has(x)).length}/${sidebarIds.length}`);
console.log('sample:', JSON.stringify(sidebarIds.slice(0, 8).map((x) => ({ id: x, ni: cachedNI.has(x), dr: cachedDR.has(x) }))));

await browser.close();
