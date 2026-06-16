// Does the /next fetch path capture the sidebar on SPA navigation (clicking
// between videos), or only the full-load ytInitialData path?
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);

const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
const cacheCount = async () => {
  const c = await ext.evaluate(() => chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null));
  const v = Object.values(c?.videos || {});
  return { total: v.length, ni: v.filter((x) => x.notInterested).length };
};

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await wait(6000);
console.log('after full load:', JSON.stringify(await cacheCount()));

// Clear, then SPA-navigate by clicking a sidebar video.
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));
await wait(500);
const beforeUrl = w.url();
const clicked = await w.evaluate(() => {
  const a = document.querySelector('#secondary a[href*="/watch?v="]');
  if (!a) return null;
  const href = a.getAttribute('href');
  a.click();
  return href;
});
await w.waitForFunction((u) => location.href !== u, beforeUrl, { timeout: 10000 }).catch(() => {});
console.log('SPA-navigated via click to:', clicked, '-> now', new URL(w.url()).search);
await wait(7000);
console.log('after SPA nav (cache was cleared first):', JSON.stringify(await cacheCount()));

await browser.close();
