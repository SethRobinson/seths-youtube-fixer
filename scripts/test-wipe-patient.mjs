// Patient RPC validation: watch ONE throwaway video, poll until it propagates to
// My Activity, then RPC-delete the last 20 min (contains only the throwaway, well
// within the authorized 3h) and verify it disappears.
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

const yt = await context.newPage();
await yt.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await wait(3000);
await yt.evaluate(() => {
  const p = document.getElementById('movie_player');
  p?.unMute?.();
  p?.playVideo?.();
});
console.log('watching throwaway 35s, then polling for propagation…');
await wait(35000);
await yt.close();

let before = null;
for (let i = 0; i < 20; i++) {
  await wait(60000);
  const now = Date.now();
  const scan = await send('scan', now - 20 * 60_000, now);
  const n = scan?.matched?.length ?? 0;
  console.log(`poll ${i + 1}: last20 matched=${n} ${JSON.stringify((scan?.matched || []).map((m) => (m.title || '').slice(0, 22)))}`);
  if (n > 0) {
    before = scan;
    break;
  }
}
if (!before) {
  console.log('RESULT: throwaway never propagated within ~20 min — inconclusive.');
  await browser.close();
  process.exit(0);
}

const now = Date.now();
const del = await send('delete', now - 20 * 60_000, now);
console.log(`DELETE: ok=${del?.ok} deleted=${del?.deleted} err=${del?.error || '-'}`);
await wait(3000);
const after = await send('scan', now - 20 * 60_000, now);
const a = after?.matched?.length ?? 0;
console.log(`RESULT: before=${before.matched.length} after=${a} -> ${a < before.matched.length ? 'RPC DELETE CONFIRMED ✓' : 'NO CHANGE ✗'}`);

await browser.close();
