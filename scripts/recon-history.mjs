// Recon (READ-ONLY): how is YouTube "Watch History" on/off represented + what
// controls toggle it? Check the activity-controls page.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const p = await context.newPage();
await p.goto('https://myactivity.google.com/activitycontrols/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(7000);

const info = await p.evaluate(() => {
  const out = { url: location.href, title: document.title };
  const toggles = [...document.querySelectorAll('[role="switch"], button[aria-pressed], [aria-checked], c-wiz [jsaction]')]
    .filter((t) => /switch|checked|pressed|pause|turn|history/i.test((t.getAttribute('aria-label') || t.textContent || '') + (t.getAttribute('role') || '')))
    .slice(0, 12)
    .map((t) => ({
      tag: t.tagName,
      role: t.getAttribute('role'),
      checked: t.getAttribute('aria-checked') ?? t.getAttribute('aria-pressed'),
      label: (t.getAttribute('aria-label') || t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    }));
  out.toggles = toggles;
  out.bodySnippet = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500);
  return out;
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
