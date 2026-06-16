// Measure feedback-cache byte cost per video and how many videos until the
// 10MB chrome.storage.local quota (where captures start silently failing).
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
for (let i = 0; i < 8; i++) {
  await home.mouse.wheel(0, 5000);
  await home.waitForTimeout(1000);
}
await home.waitForTimeout(1500);

const info = await ext.evaluate(async () => {
  const fb = (await chrome.storage.local.get('syf.feedback'))['syf.feedback'];
  const chars = JSON.stringify(fb || {}).length;
  const videos = Object.keys(fb?.videos || {}).length || 1;
  const total = await chrome.storage.local.getBytesInUse(null);
  const perVideo = chars / videos;
  return {
    videos,
    cacheChars: chars,
    perVideoBytes: Math.round(perVideo),
    totalBytesInUse: total,
    quotaBytes: 10485760,
    estVideosToQuota: Math.round(10485760 / perVideo),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
