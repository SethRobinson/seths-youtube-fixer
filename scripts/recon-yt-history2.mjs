// Find the watch-history toggle feedbackToken in ytInitialData on /feed/history,
// confirm the request body, and RESTORE history to ON (the prior recon paused it).
import { connect } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
const p = await context.newPage();
const posts = [];
p.on('request', (req) => {
  if (req.method() === 'POST' && /youtubei\/v1\/feedback/.test(req.url())) posts.push(req.postData() || '');
});

await p.bringToFront();
await p.goto('https://www.youtube.com/feed/history', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);

const data = await p.evaluate(() => {
  const re = /pause watch history|turn on watch history/i;
  const ctrl = [...document.querySelectorAll('button, a, yt-button-shape')].find((e) => re.test(e.textContent || ''));
  const state = ctrl ? (ctrl.textContent || '').trim() : '(control not found)';

  // smallest ytInitialData subtree with a feedbackToken AND history wording
  let best = null;
  const seen = new WeakSet();
  (function walk(o) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) return o.forEach(walk);
    const s = JSON.stringify(o);
    if (s.includes('feedbackToken') && /watch history|TURN_ON|PAUSE/i.test(s)) {
      if (!best || s.length < best.length) best = s;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  })(window.ytInitialData || {});
  return { state, subtree: best ? best.slice(0, 1800) : null };
});
console.log('current state:', JSON.stringify(data.state));
console.log('history-token subtree:', data.subtree);

// Toggle (restore: if paused, this turns it back ON).
const ctrl = await p.evaluate(() => {
  const re = /pause watch history|turn on watch history/i;
  const el = [...document.querySelectorAll('button, a, yt-button-shape')].find((e) => re.test(e.textContent || ''));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { t: el.textContent.trim().slice(0, 30), x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (ctrl) {
  await p.mouse.click(ctrl.x, ctrl.y);
  await p.waitForTimeout(1800);
  const cb = await p.evaluate(() => {
    const b = [...document.querySelectorAll('button, yt-button-shape')].find((x) => /^(pause|turn on)$/i.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 4);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (cb) {
    await p.mouse.click(cb.x, cb.y);
    await p.waitForTimeout(2500);
  }
  console.log(`toggled "${ctrl.t}" -> restored`);
}
console.log('feedback request body (raw):', posts[posts.length - 1]?.slice(0, 500));

await browser.close();
