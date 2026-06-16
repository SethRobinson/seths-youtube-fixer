// Recon (READ-ONLY): confirm each "Delete activity item" button can be paired
// with its timestamp by walking up to the nearest ancestor containing a time.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const p = await context.newPage();
await p.goto('https://myactivity.google.com/product/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(7000);

const rows = await p.evaluate(() => {
  const timeRe = /\b(\d{1,2}):(\d{2})\s?(AM|PM)\b/i;
  function findTime(el) {
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      const m = (cur.textContent || '').match(timeRe);
      if (m) return { time: m[0], depth: i };
      cur = cur.parentElement;
    }
    return null;
  }
  const dels = [...document.querySelectorAll('button[aria-label^="Delete activity item"]')];
  return {
    count: dels.length,
    sample: dels.slice(0, 10).map((b) => {
      const t = findTime(b);
      const title = (b.getAttribute('aria-label') || '').replace(/^Delete activity item\s*/, '').slice(0, 28);
      return { title, time: t?.time, depth: t?.depth };
    }),
  };
});

console.log(JSON.stringify(rows, null, 2));
await browser.close();
