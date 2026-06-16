// Recon (READ-ONLY, deletes nothing): inspect My Activity for YouTube to see if
// per-item timestamps + delete controls are automatable for "wipe last N min".
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const p = await context.newPage();
await p.goto('https://myactivity.google.com/product/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(7000);

const info = await p.evaluate(() => {
  const out = { url: location.href, title: document.title };
  const btns = [...document.querySelectorAll('button,[role="button"]')];
  const labels = {};
  for (const b of btns) {
    const l = (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40);
    if (l) labels[l] = (labels[l] || 0) + 1;
  }
  out.buttonLabels = Object.entries(labels)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40);

  const timeRe = /\b\d{1,2}:\d{2}\s?(AM|PM)\b/i;
  let timeCount = 0;
  const sampleTimes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.nodeValue || '').trim();
    if (t && timeRe.test(t)) {
      timeCount++;
      if (sampleTimes.length < 10) sampleTimes.push(t);
    }
  }
  out.timeCount = timeCount;
  out.sampleTimes = sampleTimes;
  out.loggedOut = /accounts\.google\.com|signin/i.test(location.href);
  return out;
});

console.log(JSON.stringify(info, null, 2));
await p.screenshot({ path: 'test-results/myactivity.png' });
await browser.close();
