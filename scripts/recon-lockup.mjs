// Decisive recon (READ-ONLY mostly; opens one menu): are feedback tokens already
// in the feed data, or only available after opening a card's 3-dot menu (and if
// so, via a fetch or inline)? Feedback tokens start with "AB9zfp".
import { connect } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
const p = await context.newPage();

const youtubei = [];
p.on('request', (req) => {
  const u = req.url();
  if (req.method() === 'POST' && /youtubei\/v1\//.test(u)) youtubei.push(u.split('?')[0].split('/v1/')[1]);
});

await p.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);
for (let i = 0; i < 2; i++) {
  await p.mouse.wheel(0, 3000);
  await p.waitForTimeout(1200);
}

// PART A — are tokens inline in the feed data (ytInitialData lockups)?
const A = await p.evaluate(() => {
  const lockups = [];
  const seen = new WeakSet();
  const has = (o, key, d) => {
    if (!o || typeof o !== 'object' || d > 22) return false;
    if (typeof o[key] === 'string') return true;
    for (const k of Object.keys(o)) if (has(o[k], key, d + 1)) return true;
    return false;
  };
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 45) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
    if (o.lockupViewModel) lockups.push(o.lockupViewModel);
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(window.ytInitialData, 0);
  const all = JSON.stringify(window.ytInitialData);
  return {
    totalLockups: lockups.length,
    lockupsWithFeedbackToken: lockups.filter((lv) => has(lv, 'feedbackToken', 0)).length,
    feedbackTokensInWholeFeed: (all.match(/AB9zfp[A-Za-z0-9_-]{20,}/g) || []).length,
  };
});

// PART B — open one card's 3-dot menu; does a fetch fire, and do tokens appear?
const reqBefore = youtubei.length;
const opened = await p.evaluate(() => {
  const sel = [
    'ytd-rich-item-renderer button[aria-label="Action menu"]',
    'ytd-rich-item-renderer button[aria-label*="More" i]',
    'yt-lockup-view-model button[aria-label*="action" i]',
    'ytd-rich-item-renderer yt-icon-button button',
    'ytd-rich-grid-media #button',
  ];
  for (const s of sel) {
    const b = document.querySelector(s);
    if (b) {
      b.click();
      return s;
    }
  }
  return 'NO-MENU-BUTTON';
});
await p.waitForTimeout(2500);
const reqDuringOpen = youtubei.slice(reqBefore);
const B = await p.evaluate(() => {
  const tokensInDom = (document.body.innerHTML.match(/AB9zfp[A-Za-z0-9_-]{20,}/g) || []).length;
  const items = [...document.querySelectorAll('tp-yt-paper-item, ytd-menu-service-item-renderer, [role="menuitem"]')]
    .map((e) => (e.textContent || '').trim())
    .filter((t) => /not interested|recommend/i.test(t));
  return { feedbackTokensInDom: tokensInDom, feedbackMenuItems: items };
});

console.log('PART A (feed inline):', JSON.stringify(A, null, 1));
console.log('PART B menu-open: clicked=%s  youtubei-fetches-during-open=%s %s', opened, reqDuringOpen.length, JSON.stringify(reqDuringOpen));
console.log('PART B (after open):', JSON.stringify(B, null, 1));
await browser.close();
