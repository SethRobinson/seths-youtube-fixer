// READ-ONLY UI test: open the Forget recent dialog, pick a preset, confirm the
// standalone review tab renders. Does NOT click Delete (no deletion).
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="wipe"]', { timeout: 30000 });
const label = await w.locator('#syf-bar [data-action="wipe"]').textContent();
const tip = await w.locator('#syf-bar [data-action="wipe"]').getAttribute('title');
console.log('button:', JSON.stringify(label), '| tip:', JSON.stringify(tip));
await w.locator('#syf-bar [data-action="wipe"]').click();
await w.waitForSelector('#syf-wipe', { timeout: 5000 });
const modalText = await w.locator('#syf-wipe').textContent();
const modalHref = await w.locator('#syf-wipe a.syf-activity-link').first().getAttribute('href');
console.log('modal:', (modalText || '').replace(/\s+/g, ' ').slice(0, 160));
console.log('activity link:', modalHref);

const newPage = context.waitForEvent('page');
await w.locator('#syf-wipe .syf-wipe-preset[data-min="120"]').click();
const wipeTab = await newPage;
await wipeTab.waitForLoadState('domcontentloaded');
console.log('wipe tab:', wipeTab.url());

// wait for the scan to actually finish (the "Scanning…" text to clear)
await wipeTab.waitForFunction(
  () => {
    const root = document.querySelector('#root');
    return root && !/Scanning/.test(root.textContent || '');
  },
  { timeout: 40000 }
);
await wait(500);

const h1 = await wipeTab.locator('h1').textContent();
const h1Href = await wipeTab.locator('#activityLink').getAttribute('href');
const items = await wipeTab.locator('.item').count();
const hasDelete = await wipeTab.locator('#del').count();
const note = await wipeTab.locator('#root').first().textContent();
console.log(`review h1=${JSON.stringify(h1)} items=${items} deleteBtnPresent=${hasDelete}`);
console.log('review link:', h1Href);
console.log('review text:', (note || '').replace(/\s+/g, ' ').slice(0, 180));
await wipeTab.screenshot({ path: 'test-results/wipe-ui.png' });

await browser.close();
