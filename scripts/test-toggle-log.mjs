// Test toggle (apply -> undo) + action log + Info panel, net-neutral.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove(['syf.feedback', 'syf.actionlog']));
console.log('cleared cache + log');

const home = await context.newPage();
await home.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await home.waitForTimeout(4000);
for (let i = 0; i < 5; i++) {
  await home.mouse.wheel(0, 4000);
  await home.waitForTimeout(1200);
}
await home.waitForTimeout(1000);

const cache = await ext.evaluate(() =>
  chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null)
);
const skip = ['3jIMk43CECY', '5eqzEDe8wHs'];
const v =
  cache && Object.values(cache.videos).find((x) => x.notInterested?.undoToken && !skip.includes(x.videoId));
if (!v) {
  console.error('No fresh video with an undo token.');
  await browser.close();
  process.exit(1);
}
console.log(`toggle test video: ${v.videoId} "${(v.title || '').slice(0, 40)}"`);

const w = await context.newPage();
w.on('console', (m) => {
  if (m.text().includes('[SYF')) console.log('PAGE:', m.text());
});
await w.goto(`https://www.youtube.com/watch?v=${v.videoId}`, { waitUntil: 'domcontentloaded' });
const nah = w.locator('#syf-bar [data-action="nah"]');
await nah.waitFor({ state: 'visible', timeout: 30000 });
await w.waitForFunction(
  () => {
    const b = document.querySelector('#syf-bar [data-action="nah"]');
    return b && !b.disabled && b.dataset.state === 'ready';
  },
  { timeout: 15000 }
);

// APPLY
await nah.click();
await w.waitForFunction(() => document.querySelector('#syf-bar [data-action="nah"]')?.dataset.state === 'sent', {
  timeout: 15000,
});
let log = await ext.evaluate(() => chrome.storage.local.get('syf.actionlog').then((o) => o['syf.actionlog'] || []));
console.log(`after APPLY: log=${log.length} undone=${log[0]?.undone} source=${log[0]?.source}`);

// UNDO (toggle off)
await nah.click();
await w.waitForFunction(() => document.querySelector('#syf-bar [data-action="nah"]')?.dataset.state === 'ready', {
  timeout: 15000,
});
log = await ext.evaluate(() => chrome.storage.local.get('syf.actionlog').then((o) => o['syf.actionlog'] || []));
console.log(`after UNDO : log=${log.length} undone=${log[0]?.undone}`);

// INFO panel
await w.locator('#syf-bar [data-action="info"]').click();
await w.waitForSelector('#syf-modal', { timeout: 5000 });
const rows = await w.locator('#syf-modal .syf-row').count();
console.log('Info panel rows:', rows);
await w.screenshot({ path: 'test-results/toggle-log.png' });

await browser.close();
