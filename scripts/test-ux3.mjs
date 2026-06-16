// Verify the Pause-history button opens YouTube's watch-history settings, and the
// bar shows the new button.
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="pause-history"]', { timeout: 30000 });
const label = await w.locator('#syf-bar [data-action="pause-history"]').textContent();
console.log('pause-history button label:', JSON.stringify(label));

await w.locator('#syf-bar [data-action="pause-history"]').click();
await wait(2000);
const histTab = context.pages().find((p) => p.url().includes('/feed/history'));
console.log('opened watch-history settings tab:', !!histTab, histTab ? '->' + histTab.url() : '');

await browser.close();
