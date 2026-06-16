// Validate the feedback replay round-trip with minimal account impact:
// submit one real "Not interested" for a captured video, inspect YouTube's
// response, then submit the undo token so the account nets ~zero.
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
const v = cache && Object.values(cache.videos).find((x) => x.notInterested);
if (!v) {
  console.error('No captured "Not interested" token. Run `node scripts/measure-feedback.mjs` first.');
  await browser.close();
  process.exit(1);
}
const token = v.notInterested.token;
console.log(`Using video ${v.videoId} "${(v.title || '').slice(0, 45)}" (token len ${token.length})`);

const w = await context.newPage();
await w.goto(`https://www.youtube.com/watch?v=${v.videoId}`, { waitUntil: 'domcontentloaded' });
await w.waitForFunction(() => typeof window.__syfSubmitFeedback === 'function', { timeout: 15000 });

// 1) Submit the real "Not interested".
const r1 = await w.evaluate((t) => window.__syfSubmitFeedback(t), token);
console.log(`\nSUBMIT  ok=${r1.ok} status=${r1.status} err=${r1.error || '-'}`);
console.log('SUBMIT json:', JSON.stringify(r1.json)?.slice(0, 1500));

// 2) Inspect every feedbackToken in the response WITH its label. YouTube's
//    "Not interested" response carries only "Tell us why" reason tokens, NOT an
//    undo — so we must not blindly resubmit them (that adds feedback, not undo).
const found = await w.evaluate((j) => {
  const out = [];
  const seen = new WeakSet();
  const label = (n) => {
    try {
      if (n.text?.runs) return n.text.runs.map((r) => r.text).join('');
      if (n.text?.simpleText) return n.text.simpleText;
    } catch {}
    return '';
  };
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 30) return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
    if (typeof o.feedbackToken === 'string') out.push({ token: o.feedbackToken, label: label(o) });
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(j, 0);
  return out;
}, r1.json);
console.log('\ntokens in response:', found.map((f) => `"${f.label}"`).join(', ') || '(none)');

// 3) Only submit a token that is genuinely an undo.
const undoEntry = found.find((f) => /undo/i.test(f.label));
if (undoEntry) {
  const r2 = await w.evaluate((t) => window.__syfSubmitFeedback(t), undoEntry.token);
  console.log(`UNDO    ok=${r2.ok} status=${r2.status} err=${r2.error || '-'}`);
} else {
  console.log('No real undo token in response (only follow-up reasons). NOT resubmitting.');
}

await w.screenshot({ path: 'test-results/validate-replay.png' });
await browser.close();
