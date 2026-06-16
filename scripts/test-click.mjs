// Test the real Nah button click path end-to-end. Prefers a video already marked
// not-interested (3jIMk43CECY from validation) so re-clicking adds zero new impact.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
const cache = await ext.evaluate(() =>
  chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null)
);
const vids = cache ? Object.values(cache.videos).filter((v) => v.notInterested) : [];
const prefer = vids.find((v) => v.videoId === '3jIMk43CECY') || vids[0];
if (!prefer) {
  console.error('No captured token. Run `node scripts/measure-feedback.mjs` first.');
  await browser.close();
  process.exit(1);
}
const known = prefer.videoId === '3jIMk43CECY';
console.log(`Clicking Nah on ${prefer.videoId} ${known ? '(already marked — zero new impact)' : '(NEW not-interested!)'}`);

const w = await context.newPage();
w.on('console', (m) => {
  if (m.text().includes('[SYF')) console.log('PAGE:', m.text());
});
await w.goto(`https://www.youtube.com/watch?v=${prefer.videoId}`, { waitUntil: 'domcontentloaded' });

const nah = w.locator('#syf-bar [data-action="nah"]');
await nah.waitFor({ state: 'visible', timeout: 30000 });
await w.waitForFunction(
  () => {
    const b = document.querySelector('#syf-bar [data-action="nah"]');
    return b && !b.disabled;
  },
  { timeout: 15000 }
);
await nah.click();
await w
  .waitForFunction(
    () => {
      const b = document.querySelector('#syf-bar [data-action="nah"]');
      return b && (b.dataset.state === 'sent' || b.dataset.state === 'error');
    },
    { timeout: 15000 }
  )
  .catch(() => {});

const final = await w.evaluate(() => {
  const b = document.querySelector('#syf-bar [data-action="nah"]');
  return { state: b?.dataset.state, text: b?.textContent };
});
console.log('Nah final:', JSON.stringify(final));
await w.screenshot({ path: 'test-results/nah-click.png' });
await browser.close();
