// Is home-feed capture actually broken, or was the previous test just unable to
// click? Probe what's on the home page and whether ytd-browse.data carries the
// feed with feedback tokens.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));

const w = await context.newPage();
await w.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await wait(9000);

const probe = await w.evaluate(() => {
  const browse = document.querySelector('ytd-browse');
  const d = browse && browse.data;
  const ds = d ? JSON.stringify(d) : '';
  const grid = document.querySelector('ytd-rich-grid-renderer');
  const gridData = grid && grid.data;
  const gs = gridData ? JSON.stringify(gridData) : '';
  return {
    url: location.href,
    title: document.title,
    renderedVideoCards: document.querySelectorAll('ytd-rich-item-renderer a[href*="/watch?v="]').length,
    browsePresent: !!browse,
    browseDataPresent: !!d,
    browseDataBytes: ds.length,
    browseFeedbackTokens: (ds.match(/feedbackToken/g) || []).length,
    gridDataBytes: gs.length,
    gridFeedbackTokens: (gs.match(/feedbackToken/g) || []).length,
    ytInitialDataTokens: (() => { try { return (JSON.stringify(window.ytInitialData).match(/feedbackToken/g) || []).length; } catch { return -1; } })(),
  };
});
const cache = await ext.evaluate(async () => {
  const fb = (await chrome.storage.local.get('syf.feedback'))['syf.feedback'];
  return { videos: Object.keys(fb?.videos || {}).length, channels: Object.keys(fb?.channels || {}).length };
});
console.log(JSON.stringify({ ...probe, cache }, null, 2));
await browser.close();
