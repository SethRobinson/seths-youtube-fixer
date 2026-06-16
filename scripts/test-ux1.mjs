// Test hide-shorts + Find-in-comments-opens-config.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);

const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
// hideShorts on, no api key
await ext.evaluate(() => chrome.storage.local.set({ 'syf.settings': { hideShorts: true, apiKey: '' } }));

// --- hide shorts ---
const home = await context.newPage();
await home.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await home.waitForTimeout(5000);
const shorts = await home.evaluate(() => {
  const cls = document.documentElement.classList.contains('syf-hide-shorts');
  const sel = 'ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model';
  const els = [...document.querySelectorAll(sel)];
  const visible = els.filter((e) => e.getClientRects().length > 0).length;
  return { classApplied: cls, shortsElements: els.length, shortsVisible: visible };
});
console.log('HIDE-SHORTS:', JSON.stringify(shorts));

// --- find in comments with no key -> opens options ---
await ext.close(); // close the pre-existing options tab so a fresh open is observable
await wait(500);
const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#syf-bar [data-action="find-comments"]', { timeout: 30000 });
const before = context.pages().filter((p) => p.url().includes('/options/options.html')).length;
await w.locator('#syf-bar [data-action="find-comments"]').click();
await wait(2000);
const toast = await w.locator('#syf-toast').textContent().catch(() => '');
const after = context.pages().filter((p) => p.url().includes('/options/options.html')).length;
console.log(`FIND-COMMENTS: optionsTabs ${before}->${after}  toast="${(toast || '').slice(0, 40)}"`);

await browser.close();
