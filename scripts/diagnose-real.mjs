// NON-DESTRUCTIVE: read the real current cache state + directly test whether
// unlimitedStorage is actually in effect (does an 11MB write succeed?).
import { connect, findExtensionId } from './chrome-lib.mjs';

const { browser, context } = await connect(); // no reload, no clear
const id = await findExtensionId(context);
const p = await context.newPage();
await p.goto(`chrome-extension://${id}/options/options.html`);

const info = await p.evaluate(async () => {
  const fb = (await chrome.storage.local.get('syf.feedback'))['syf.feedback'];
  const videos = Object.keys(fb?.videos || {}).length;
  const channels = Object.keys(fb?.channels || {}).length;
  const fbBytes = await chrome.storage.local.getBytesInUse('syf.feedback');
  const total = await chrome.storage.local.getBytesInUse(null);

  // Directly test whether unlimitedStorage is active: try to write 11 MB.
  let unlimitedStorageActive = true;
  let writeErr = '';
  try {
    await chrome.storage.local.set({ __syf_quota_test: 'x'.repeat(11 * 1024 * 1024) });
  } catch (e) {
    unlimitedStorageActive = false;
    writeErr = String(e).slice(0, 120);
  }
  await chrome.storage.local.remove('__syf_quota_test').catch(() => {});

  return { videos, channels, fbBytes, totalBytesInUse: total, unlimitedStorageActive, writeErr };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
