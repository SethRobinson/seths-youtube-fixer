// Capture the "watch history on/off" toggle RPC: flip it, capture the request,
// then flip back to restore (net-neutral). Uses a real mouse click (Material switch).
import { connect } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
const p = await context.newPage();
const posts = [];
p.on('request', (req) => {
  const u = req.url();
  if (req.method() === 'POST' && /batchexecute/i.test(u)) posts.push({ url: u, body: req.postData() || '' });
});

await p.bringToFront();
await p.goto('https://myactivity.google.com/product/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(7000);

const sw = await p.evaluate(() => {
  const s = document.querySelector('[role="switch"]');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { checked: s.getAttribute('aria-checked'), label: (s.getAttribute('aria-label') || '').slice(0, 60), x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('switch:', JSON.stringify(sw));
if (!sw) {
  console.log('No [role=switch] found.');
  await browser.close();
  process.exit(0);
}

const n0 = posts.length;
await p.mouse.click(sw.x, sw.y); // flip
await p.waitForTimeout(2500);
// A confirm dialog may appear (Pause). Click its primary action via real mouse.
const confirmBox = await p.evaluate(() => {
  const b = [...document.querySelectorAll('button,[role="button"]')].find(
    (x) => /^(pause|turn off|got it|confirm|ok)$/i.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 4
  );
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, t: b.textContent.trim() };
});
if (confirmBox) {
  console.log('confirm:', confirmBox.t);
  await p.mouse.click(confirmBox.x, confirmBox.y);
  await p.waitForTimeout(2500);
}

console.log('batchexecute POSTs after toggle:', posts.length - n0);
for (const r of posts.slice(n0)) {
  console.log('URL :', decodeURIComponent(r.url).split('&')[0]);
  console.log('rpcids:', new URL(r.url).searchParams.get('rpcids'));
  console.log('BODY:', decodeURIComponent(r.body).slice(0, 700));
}

// restore: reload + flip back to original state
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);
const sw2 = await p.evaluate(() => {
  const s = document.querySelector('[role="switch"]');
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { checked: s.getAttribute('aria-checked'), x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('after toggle, switch state:', sw2?.checked, '(was', sw.checked + ')');
if (sw2 && sw2.checked !== sw.checked) {
  await p.mouse.click(sw2.x, sw2.y);
  await p.waitForTimeout(2000);
  const cb = await p.evaluate(() => {
    const b = [...document.querySelectorAll('button,[role="button"]')].find((x) => /^(turn on|got it|confirm|ok)$/i.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 4);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (cb) await p.mouse.click(cb.x, cb.y);
  await p.waitForTimeout(2000);
  console.log('restored to original state');
}

await browser.close();
