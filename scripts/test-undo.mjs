// Prove the undo round-trip: capture a fresh video's action+undo tokens, submit
// "Not interested", then submit its undo token. If both process, it's net-neutral.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);

// Re-capture with undo-token support.
const home = await context.newPage();
await home.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await home.waitForTimeout(4000);
for (let i = 0; i < 4; i++) {
  await home.mouse.wheel(0, 4000);
  await home.waitForTimeout(1200);
}
await home.waitForTimeout(1000);

const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
const cache = await ext.evaluate(() =>
  chrome.storage.local.get('syf.feedback').then((o) => o['syf.feedback'] || null)
);
const v =
  cache &&
  Object.values(cache.videos).find(
    (x) => x.notInterested?.undoToken && x.videoId !== '3jIMk43CECY'
  );
if (!v) {
  console.error('No freshly-captured video with an undo token. Re-run.');
  await browser.close();
  process.exit(1);
}
console.log(`Test video: ${v.videoId} "${(v.title || '').slice(0, 45)}"`);
console.log(`action token len=${v.notInterested.token.length}  undo token len=${v.notInterested.undoToken.length}`);

const w = await context.newPage();
await w.goto(`https://www.youtube.com/watch?v=${v.videoId}`, { waitUntil: 'domcontentloaded' });
await w.waitForFunction(() => typeof window.__syfSubmitFeedback === 'function', { timeout: 15000 });

const mark = await w.evaluate((t) => window.__syfSubmitFeedback(t), v.notInterested.token);
console.log(`MARK  ok=${mark.ok} processed=${mark.json?.feedbackResponses?.[0]?.isProcessed} status=${mark.status}`);
await w.waitForTimeout(900);

const undo = await w.evaluate((t) => window.__syfSubmitFeedback(t), v.notInterested.undoToken);
console.log(`UNDO  ok=${undo.ok} processed=${undo.json?.feedbackResponses?.[0]?.isProcessed} status=${undo.status}`);
console.log('UNDO json:', JSON.stringify(undo.json)?.slice(0, 500));

await browser.close();
