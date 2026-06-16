// READ-ONLY test of the wipe SCAN pipeline (deletes nothing): asks the SW to
// open My Activity and report which items fall in a window.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);

const now = Date.now();
const startMs = now - 6 * 3600 * 1000; // last 6 hours, to catch recent test-watches
console.log('window:', new Date(startMs).toLocaleTimeString(), '->', new Date(now).toLocaleTimeString());

const res = await ext.evaluate(
  ({ startMs, endMs }) => chrome.runtime.sendMessage({ type: 'SYF_WIPE', mode: 'scan', startMs, endMs }),
  { startMs, endMs: now }
);

console.log(`scan ok=${res?.ok} matched=${res?.matched?.length ?? 0} err=${res?.error || '-'}`);
console.log(
  'sample:',
  JSON.stringify((res?.matched || []).slice(0, 8).map((m) => ({ t: m.timeText, title: (m.title || '').slice(0, 32) })), null, 1)
);

await browser.close();
