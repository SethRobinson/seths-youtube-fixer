// Verify click-time capture: after clearing the cache, clicking a sidebar video
// should capture THAT video (via the click handler), independent of the slower
// full-sidebar capture.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await wait(6000); // let the bridge index the sidebar

const vid = await w.evaluate(() => {
  const a = document.querySelector('#secondary a[href*="/watch?v="]');
  const m = a?.href.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
});
console.log('target sidebar video:', vid);

// Clear the cache, then click it. Only the click-time capture can re-populate it.
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));
await wait(300);
await w.evaluate(() => document.querySelector('#secondary a[href*="/watch?v="]').click());
await wait(2500);

const cached = await ext.evaluate(
  (v) =>
    chrome.storage.local.get('syf.feedback').then((o) => {
      const fb = o['syf.feedback'];
      return { has: !!fb?.videos?.[v], ni: !!fb?.videos?.[v]?.notInterested, total: Object.keys(fb?.videos || {}).length };
    }),
  vid
);
console.log('clicked video cached:', JSON.stringify(cached));

await browser.close();
