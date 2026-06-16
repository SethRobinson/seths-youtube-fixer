// Test the inline pause-history toggle from the bar (net-neutral: flip + flip back).
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
const sel = '#syf-bar [data-action="pause-history"]';
await w.waitForSelector(sel, { timeout: 30000 });
const labelOf = () => w.locator(sel).textContent();

const L1 = await labelOf();
console.log('label1:', JSON.stringify(L1));

await w.locator(sel).click();
await w
  .waitForFunction((s) => {
    const b = document.querySelector(s);
    return b && b.dataset.state !== 'loading' && b.textContent !== 'Working…';
  }, sel, { timeout: 30000 })
  .catch(() => {});
await wait(1000);
const L2 = await labelOf();
const toast2 = await w.locator('#syf-toast').textContent().catch(() => '');
console.log('label2:', JSON.stringify(L2), 'toast:', JSON.stringify((toast2 || '').slice(0, 30)), 'flipped:', L1 !== L2);

await w.locator(sel).click();
await w
  .waitForFunction((s) => {
    const b = document.querySelector(s);
    return b && b.dataset.state !== 'loading' && b.textContent !== 'Working…';
  }, sel, { timeout: 30000 })
  .catch(() => {});
await wait(1000);
const L3 = await labelOf();
console.log('label3:', JSON.stringify(L3), 'restored:', L3 === L1);

await browser.close();
