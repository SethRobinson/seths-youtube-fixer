// Recon Adapter B: capture the My Activity delete RPC. Triggers ONE real deletion
// (a test-watch) via a trusted mouse click and records the batchexecute POST so we
// can replicate it from the extension.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const p = await context.newPage();

const posts = [];
p.on('request', (req) => {
  const u = req.url();
  if (req.method() === 'POST' && /batchexecute/i.test(u)) {
    posts.push({ url: u, body: req.postData() || '' });
  }
});

await p.bringToFront();
await p.goto('https://myactivity.google.com/product/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);

const count = () => p.evaluate(() => document.querySelectorAll('button[aria-label^="Delete activity item"]').length);
const before = await count();
const label = await p.evaluate(() => document.querySelector('button[aria-label^="Delete activity item"]')?.getAttribute('aria-label'));
console.log('deleting:', (label || '').slice(0, 55));

const postsBefore = posts.length;
await p.evaluate(() => {
  const t = document.querySelector('button[aria-label^="Delete activity item"]');
  for (const e of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, view: window }));
});
await p.waitForTimeout(1800);
const box = await p.evaluate(() => {
  const b = [...document.querySelectorAll('button,[role="button"]')].find(
    (x) => (x.textContent || '').trim() === 'Delete' && x.getBoundingClientRect().width > 4
  );
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (box) await p.mouse.click(box.x, box.y);
await p.waitForTimeout(3500);

const after = await count();
console.log(`deleted? ${before} -> ${after} ${after < before ? 'YES ✓' : 'NO'}`);
console.log(`batchexecute POSTs during delete: ${posts.length - postsBefore}`);
for (const r of posts.slice(postsBefore)) {
  console.log('========');
  console.log('URL :', decodeURIComponent(r.url).slice(0, 240));
  console.log('BODY:', decodeURIComponent(r.body).slice(0, 1600));
}
await browser.close();
