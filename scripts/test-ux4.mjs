// Test: Forget recent -> in-page presets -> preset opens scan in a new tab; Info -> in-page
// settings dialog (iframe of options.html) with credits/reset/log.
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="wipe"]', { timeout: 30000 });

// Forget recent presets -> new tab
await w.locator('#syf-bar [data-action="wipe"]').click();
await w.waitForSelector('#syf-wipe .syf-wipe-preset', { timeout: 5000 });
const presetCount = await w.locator('#syf-wipe .syf-wipe-preset').count();
await w.locator('#syf-wipe .syf-wipe-preset[data-min="15"]').click();
await wait(1500);
const wipeTab = context.pages().find((p) => p.url().includes('/wipe/wipe.html'));
console.log(`FORGET: presets=${presetCount} | preset->newtab=${!!wipeTab} ${wipeTab ? new URL(wipeTab.url()).search : ''}`);
const modalGone = (await w.locator('#syf-wipe').count()) === 0;
console.log('  in-page dialog closed after pick:', modalGone);

// Info -> settings iframe
await w.locator('#syf-bar [data-action="info"]').click();
await w.waitForSelector('#syf-settings iframe', { timeout: 5000 });
await wait(2500);
const optFrame = w.frames().find((f) => f.url().includes('/options/options.html'));
console.log('SETTINGS dialog iframe loaded:', !!optFrame);
if (optFrame) {
  const credit = await optFrame.locator('footer').textContent().catch(() => '');
  const reset = await optFrame.locator('#reset').count();
  const logSec = await optFrame.locator('#log').count();
  console.log('  credit:', (credit || '').replace(/\s+/g, ' ').trim().slice(0, 55));
  console.log('  reset button:', reset === 1, '| log section:', logSec === 1);
} else {
  console.log('  (iframe blocked — likely CSP)');
}

await browser.close();
