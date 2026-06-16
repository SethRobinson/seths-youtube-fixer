// Validate Adapter B (RPC delete) strictly within an authorized recent window.
// Watch ONE throwaway video, poll until it propagates to My Activity, then delete
// the last 15 min (which contains only that throwaway) and verify via re-scan.
// No fallback / no wider-window deletion.
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

// Watch a throwaway video with forced playback.
const yt = await context.newPage();
await yt.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await wait(3000);
await yt.evaluate(() => {
  const p = document.getElementById('movie_player');
  p?.unMute?.();
  p?.playVideo?.();
});
const state = await yt.evaluate(() => document.getElementById('movie_player')?.getPlayerState?.());
console.log('player state (1=playing):', state, '— watching 35s…');
await wait(35000);
await yt.close();

// Poll until the throwaway item shows up in the last 15 min (or give up).
let before = { matched: [] };
for (let i = 0; i < 6; i++) {
  await wait(35000);
  const now = Date.now();
  const scan = await send('scan', now - 15 * 60_000, now);
  const n = scan?.matched?.length ?? 0;
  console.log(`poll ${i + 1}: last15 matched=${n}`, JSON.stringify((scan?.matched || []).map((m) => (m.title || '').slice(0, 24))));
  if (n > 0) {
    before = scan;
    break;
  }
}
if (!before.matched.length) {
  console.log('Throwaway watch never propagated to My Activity in time — cannot validate this run.');
  await browser.close();
  process.exit(0);
}

const now = Date.now();
const winStart = now - 15 * 60_000;
const del = await send('delete', winStart, now);
console.log(`DELETE: ok=${del?.ok} deleted=${del?.deleted} err=${del?.error || '-'}`);
await wait(2500);
const after = await send('scan', winStart, now);
console.log(`AFTER: last15 matched=${after?.matched?.length ?? 0}  ${(after?.matched?.length ?? 0) < before.matched.length ? 'FEWER ✓ (RPC delete works)' : 'no change'}`);

await browser.close();
