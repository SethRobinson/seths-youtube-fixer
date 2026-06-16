// Does the My Activity content script actually inject?
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const p = await context.newPage();
let ready = false;
p.on('console', (m) => {
  const t = m.text();
  if (t.includes('[SYF]')) {
    console.log('MA console:', t);
    if (t.includes('My Activity content script ready')) ready = true;
  }
});
await p.goto('https://myactivity.google.com/product/youtube', { waitUntil: 'domcontentloaded' });
await wait(6000);
console.log('>>> content script injected:', ready);
console.log('>>> final url:', p.url());
await browser.close();
