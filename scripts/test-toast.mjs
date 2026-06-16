// Verify clicking a grayed-out Nah/Hate button shows an explanatory toast.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove(['syf.feedback'])); // ensure Nah is unavailable

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="nah"]', { timeout: 30000 });
await w.waitForFunction(
  () => document.querySelector('#syf-bar [data-action="nah"]')?.dataset.state === 'disabled',
  { timeout: 10000 }
);

await w.locator('#syf-bar [data-action="nah"]').click();
await w.waitForSelector('#syf-toast', { timeout: 5000 });
const toastText = await w.locator('#syf-toast').textContent();
console.log('toast shown:', JSON.stringify((toastText || '').slice(0, 70) + '…'));
await w.screenshot({ path: 'test-results/toast.png' });

await browser.close();
