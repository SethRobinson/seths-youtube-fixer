// Measure Feature 1: browse the real home feed, capture feedback tokens, then
// verify Nah / Hate light up on a watch page for a captured video.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const { browser, context } = await connect();
await reloadExtension(context);
await new Promise((r) => setTimeout(r, 1500));

const id = await findExtensionId(context);
if (!id) {
  console.error('Extension not loaded — run `npm run setup`.');
  await browser.close();
  process.exit(1);
}
console.log('ext id:', id);

// Clear cache for a clean measurement (chrome.storage from an extension page).
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));
console.log('cleared feedback cache');

// Browse home + scroll to trigger continuation fetches.
const home = await context.newPage();
await home.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await home.waitForTimeout(4000);
for (let i = 0; i < 6; i++) {
  await home.mouse.wheel(0, 4000);
  await home.waitForTimeout(1500);
}
await home.waitForTimeout(1500);

const cache = await ext.evaluate(() =>
  chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null)
);
const videos = cache ? Object.values(cache.videos) : [];
const ni = videos.filter((v) => v.notInterested);
const dr = videos.filter((v) => v.dontRecommendChannel);
console.log('STATS:', JSON.stringify(cache?.stats || {}));
console.log(
  `captured: videos=${videos.length}  withNotInterested=${ni.length}  withDontRecommend=${dr.length}  channels=${Object.keys(cache?.channels || {}).length}`
);

// Verify availability on a watch page for a captured video.
if (ni.length) {
  const pick = ni[0];
  const w = await context.newPage();
  await w.goto(`https://www.youtube.com/watch?v=${pick.videoId}`, { waitUntil: 'domcontentloaded' });
  await w.waitForSelector('#syf-bar', { timeout: 30000 });
  await w.waitForTimeout(3000); // allow WATCH_CONTEXT + lookup
  const state = await w.evaluate(() => {
    const q = (a) => document.querySelector(`#syf-bar [data-action="${a}"]`);
    const nah = q('nah');
    const hate = q('hate-channel');
    return { nah: !!(nah && !nah.disabled), hate: !!(hate && !hate.disabled) };
  });
  console.log(`WATCH ${pick.videoId} "${(pick.title || '').slice(0, 45)}" -> Nah=${state.nah} Hate=${state.hate}`);
  await w.screenshot({ path: 'test-results/feature1-watch.png' });
  await w.close();
} else {
  console.log('No notInterested tokens captured — cannot verify watch-page availability.');
}

await ext.close();
await home.close();
await browser.close();
