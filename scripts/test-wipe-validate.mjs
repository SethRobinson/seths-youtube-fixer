// User-authorized validation: delete the last 3 HOURS of YouTube activity via the
// Adapter B RPC, with before/after scans to confirm. Strictly a 3-hour window.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
const send = (mode, startMs, endMs) =>
  ext.evaluate(({ mode, startMs, endMs }) => chrome.runtime.sendMessage({ type: 'SYF_WIPE', mode, startMs, endMs }), { mode, startMs, endMs });

const now = Date.now();
const startMs = now - 3 * 3600 * 1000; // last 3 hours (authorized)

const before = await send('scan', startMs, now);
console.log(`BEFORE last-3h: matched=${before?.matched?.length ?? 0}`);
console.log('items:', JSON.stringify((before?.matched || []).map((m) => `${m.timeText} ${(m.title || '').slice(0, 30)}`), null, 1));

const del = await send('delete', startMs, now);
console.log(`DELETE: ok=${del?.ok} deleted=${del?.deleted} err=${del?.error || '-'}`);

await wait(3000);
const after = await send('scan', startMs, Date.now());
const a = after?.matched?.length ?? 0;
const b = before?.matched?.length ?? 0;
console.log(`AFTER last-3h: matched=${a}  ${a < b ? `FEWER ✓ (deleted ${b - a}, RPC works)` : 'no change'}`);

await browser.close();
