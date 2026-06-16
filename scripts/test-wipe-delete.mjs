// REAL deletion test (user-approved): delete the last 30 minutes of YouTube
// activity, with before/after scans to confirm. This is irreversible.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);

const now = Date.now();
const startMs = now - 30 * 60_000;
const send = (mode) =>
  ext.evaluate(
    ({ mode, startMs, endMs }) => chrome.runtime.sendMessage({ type: 'SYF_WIPE', mode, startMs, endMs }),
    { mode, startMs, endMs: now }
  );

const before = await send('scan');
console.log(`BEFORE: matched=${before?.matched?.length ?? 0}`);
console.log('items:', JSON.stringify((before?.matched || []).map((m) => `${m.timeText} ${(m.title || '').slice(0, 32)}`), null, 1));

console.log('--- deleting (REAL, approved) ---');
const del = await send('delete');
console.log(`DELETE: ok=${del?.ok} deleted=${del?.deleted ?? 0} remaining=${del?.matched?.length ?? 0} err=${del?.error || '-'}`);

await wait(2500);
const after = await send('scan');
console.log(`AFTER: matched=${after?.matched?.length ?? 0}`);

await browser.close();
