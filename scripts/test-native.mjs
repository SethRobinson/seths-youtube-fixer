// Validate native-action capture: when YouTube's OWN feedback POST fires, our
// bridge should detect it (token matches our captured index) and log it as
// source:'native'. We simulate the native fetch with an indexed token — the same
// window.fetch path YouTube's own menu uses (our own submissions use origFetch,
// so they are not double-counted).
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove(['syf.actionlog']));

// Home yields classic videoRenderer tokens we can index.
const w = await context.newPage();
w.on('console', (m) => {
  if (m.text().includes('[SYF')) console.log('PAGE:', m.text());
});
await w.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await w.waitForTimeout(4000);
for (let i = 0; i < 4; i++) {
  await w.mouse.wheel(0, 4000);
  await w.waitForTimeout(1200);
}
await w.waitForFunction(() => window.__syfDebug && window.__syfDebug.size() > 0, { timeout: 15000 });
console.log('bridge tokenIndex size:', await w.evaluate(() => window.__syfDebug.size()));

// Simulate the native feedback POST with an indexed token.
const tok = await w.evaluate(() => window.__syfDebug.firstToken());
await w.evaluate(
  (t) =>
    window
      .fetch('/youtubei/v1/feedback?prettyPrint=false', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedbackTokens: [t] }),
      })
      .catch(() => {}),
  tok
);
await w.waitForTimeout(1800);

const log = await ext.evaluate(() => chrome.storage.local.get('syf.actionlog').then((o) => o['syf.actionlog'] || []));
const native = log.find((e) => e.source === 'native');
console.log(`native capture: logged=${!!native} totalEntries=${log.length}`);
if (native)
  console.log('entry:', JSON.stringify({ type: native.type, videoId: native.videoId, title: (native.title || '').slice(0, 35), hasUndo: !!native.undoToken }));

// net-neutral cleanup: undo any applied native entries.
for (const e of log.filter((x) => x.source === 'native' && !x.undone && x.undoToken)) {
  await w.evaluate((t) => window.__syfSubmitFeedback(t), e.undoToken);
  console.log('undid native action for', e.videoId);
}

await browser.close();
