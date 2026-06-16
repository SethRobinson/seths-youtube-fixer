// Debug the real My Activity delete interaction in a VISIBLE tab: what happens
// when we click a "Delete activity item" button — immediate delete, or a confirm?
import { connect } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
const p = await context.newPage();
await p.bringToFront();
await p.goto('https://myactivity.google.com/product/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);

const before = await p.evaluate(() => document.querySelectorAll('button[aria-label^="Delete activity item"]').length);
const btn = p.locator('button[aria-label^="Delete activity item"]').first();
const label = await btn.getAttribute('aria-label');
console.log('delete buttons before:', before, '| clicking:', (label || '').slice(0, 55));

await btn.click();
await p.waitForTimeout(2500);

const info = await p.evaluate(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].map((d) => (d.textContent || '').slice(0, 140));
  const dialogButtons = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].map(
    (b) => (b.textContent || '').trim() || b.getAttribute('aria-label')
  );
  const snack = [...document.querySelectorAll('*')]
    .filter((e) => e.children.length <= 2 && /\b(deleted|removed|undo)\b/i.test(e.textContent || ''))
    .slice(0, 4)
    .map((e) => (e.textContent || '').trim().slice(0, 60));
  return { dialogs, dialogButtons, snack };
});
console.log('after click:', JSON.stringify(info, null, 1));

const after = await p.evaluate(() => document.querySelectorAll('button[aria-label^="Delete activity item"]').length);
console.log('delete buttons after:', after, after < before ? '(DELETED ✓)' : '(no change)');
await p.screenshot({ path: 'test-results/ma-delete-debug.png' });
await browser.close();
