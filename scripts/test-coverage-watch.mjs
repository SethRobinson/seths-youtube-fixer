// Verify the coverage fix end-to-end: browse home (captures lockup cards), open a
// captured video, confirm Hate content / Hate channel are enabled + renamed.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));

const home = await context.newPage();
await home.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await home.waitForTimeout(4000);
for (let i = 0; i < 3; i++) {
  await home.mouse.wheel(0, 4000);
  await home.waitForTimeout(1200);
}
const cache = await ext.evaluate(() => chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null));
const v = cache && Object.values(cache.videos).find((x) => x.notInterested && x.dontRecommendChannel && x.channelId);
console.log('captured videos:', Object.keys(cache?.videos || {}).length, 'channels:', Object.keys(cache?.channels || {}).length);
console.log('test video:', v?.videoId, (v?.title || '').slice(0, 38), 'channel:', v?.channelId);

const w = await context.newPage();
await w.goto(`https://www.youtube.com/watch?v=${v.videoId}`, { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar', { timeout: 30000 });
await w.waitForTimeout(3000);
const btns = await w.evaluate(() =>
  ['nah', 'hate-channel'].map((a) => {
    const b = document.querySelector(`#syf-bar [data-action="${a}"]`);
    return { action: a, label: b?.textContent, enabled: b && !b.disabled, state: b?.dataset.state };
  })
);
console.log('buttons:', JSON.stringify(btns, null, 1));
await w.screenshot({ path: 'test-results/coverage-watch.png' });
await browser.close();
