// Dump the exact lockupViewModel menu structure (the smallest subtree holding a
// feedbackToken + "Not interested") so we can write the extractor + classifier.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const p = await context.newPage();
await p.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);

const r = await p.evaluate(() => {
  let lockup = null;
  const seen = new WeakSet();
  (function walk(o, d) {
    if (lockup || !o || typeof o !== 'object' || d > 45) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
    if (o.lockupViewModel) {
      lockup = o.lockupViewModel;
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(window.ytInitialData, 0);
  if (!lockup) return { error: 'no lockup' };

  // smallest subtree containing a feedbackToken AND "not interested"
  let best = null;
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 28) return;
    if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
    const s = JSON.stringify(o);
    if (s.includes('feedbackToken') && /not interested/i.test(s)) {
      if (!best || s.length < best.length) best = s;
    }
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(lockup, 0);

  // also: how is contentId placed, and the top structure
  return {
    contentId: lockup.contentId,
    lockupTopKeys: Object.keys(lockup),
    menuSubtree: best ? best.slice(0, 4500) : null,
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
