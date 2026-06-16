// Recon the "Pause / Turn on watch history" control on youtube.com/feed/history:
// read current state, capture the toggle request, then toggle back (net-neutral).
import { connect } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
const p = await context.newPage();

const posts = [];
p.on('request', (req) => {
  const u = req.url();
  if (req.method() === 'POST' && /youtubei\/v1\/|batchexecute/.test(u)) posts.push({ url: u, body: req.postData() || '' });
});

await p.bringToFront();
await p.goto('https://www.youtube.com/feed/history', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);

// Find the pause/resume control + read state.
function findCtrlExpr() {
  return () => {
    const re = /pause watch history|turn on watch history|pause history|resume/i;
    const els = [...document.querySelectorAll('button, a, tp-yt-paper-button, yt-button-shape')];
    const el = els.find((e) => re.test((e.textContent || '').trim()));
    if (!el) return null;
    const b = el.tagName === 'BUTTON' ? el : el.querySelector('button') || el;
    const r = (b.getBoundingClientRect && b.getBoundingClientRect()) || el.getBoundingClientRect();
    return { text: (el.textContent || '').trim().slice(0, 40), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
}
const ctrl = await p.evaluate(findCtrlExpr());
console.log('control:', JSON.stringify(ctrl));

if (!ctrl) {
  // dump candidate control texts to find it
  const cands = await p.evaluate(() =>
    [...document.querySelectorAll('button, a')]
      .map((e) => (e.textContent || '').trim())
      .filter((t) => /history|pause|turn/i.test(t) && t.length < 40)
      .slice(0, 20)
  );
  console.log('no direct control. candidates:', JSON.stringify(cands));
  await browser.close();
  process.exit(0);
}

const n0 = posts.length;
await p.mouse.click(ctrl.x, ctrl.y);
await p.waitForTimeout(2000);
// confirm dialog primary action
const confirm = await p.evaluate(() => {
  const b = [...document.querySelectorAll('button, tp-yt-paper-button, yt-button-shape')].find(
    (x) => /^(pause|turn on|turn off|got it|confirm)$/i.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 4
  );
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { t: b.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (confirm) {
  console.log('confirm button:', confirm.t);
  await p.mouse.click(confirm.x, confirm.y);
  await p.waitForTimeout(2500);
}

console.log('--- requests during toggle:', posts.length - n0);
for (const r of posts.slice(n0)) {
  const path = decodeURIComponent(r.url).split('?')[0];
  const rpcids = /batchexecute/.test(r.url) ? new URL(r.url).searchParams.get('rpcids') : '';
  console.log('PATH:', path.slice(-60), rpcids ? '(rpcids=' + rpcids + ')' : '');
  console.log('BODY:', decodeURIComponent(r.body).slice(0, 600));
}

await browser.close();
