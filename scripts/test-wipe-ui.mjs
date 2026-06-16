// READ-ONLY UI test: open the Wipe dialog, pick a preset, confirm the review
// list renders. Does NOT click Delete (no deletion).
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="wipe"]', { timeout: 30000 });
await w.locator('#syf-bar [data-action="wipe"]').click();
await w.waitForSelector('#syf-wipe', { timeout: 5000 });
await w.locator('#syf-wipe .syf-wipe-preset[data-min="120"]').click();
// wait for the scan to actually finish (the "Scanning…" text to clear)
await w.waitForFunction(
  () => {
    const b = document.querySelector('#syf-wipe .syf-wipe-body');
    return b && !/Scanning/.test(b.textContent || '');
  },
  { timeout: 40000 }
);
await wait(500);

const items = await w.locator('#syf-wipe .syf-wipe-item').count();
const hasDelete = await w.locator('#syf-wipe .syf-wipe-delete').count();
const note = await w.locator('#syf-wipe .syf-wipe-body').first().textContent();
console.log(`review items=${items} deleteBtnPresent=${hasDelete}`);
console.log('dialog text:', (note || '').replace(/\s+/g, ' ').slice(0, 160));
await w.screenshot({ path: 'test-results/wipe-ui.png' });

await browser.close();
