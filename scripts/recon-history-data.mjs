// READ-ONLY: dump every feedbackToken in /feed/history's data with its structural
// context (enclosing *Renderer, nearest iconType, nearest label) so we can identify
// the pause/resume control WITHOUT its localized label. English is fine — the data
// STRUCTURE is language-independent.
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1000);
const p = await context.newPage();

await p.goto('https://www.youtube.com/feed/history', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!document.querySelector('ytd-browse')?.data, { timeout: 15000 }).catch(() => {});
await wait(2500);

const out = await p.evaluate(() => {
  const textOf = (t) =>
    t?.runs ? t.runs.map((r) => r.text).join('') : t?.simpleText || (typeof t?.content === 'string' ? t.content : '');
  const data = document.querySelector('ytd-browse')?.data || window.ytInitialData;
  const tokens = [];
  (function walk(o, keyName, ctx) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return void o.forEach((v) => walk(v, keyName, ctx));
    const renderer = keyName && keyName.endsWith('Renderer') ? keyName : ctx.renderer;
    let icon = ctx.icon;
    if (typeof o.iconType === 'string') icon = o.iconType;
    if (o.icon?.iconType) icon = o.icon.iconType;
    let label = ctx.label;
    const lbl = textOf(o.text) || textOf(o.title) || (typeof o.content === 'string' ? o.content : '');
    if (lbl) label = lbl.slice(0, 28);
    const childCtx = { renderer, icon, label };
    if (typeof o.feedbackToken === 'string') {
      // path of renderer ancestors for extra context
      tokens.push({ token: o.feedbackToken.slice(0, 8) + '…', renderer, icon, label });
    }
    for (const k of Object.keys(o)) walk(o[k], k, childCtx);
  })(data, '', { renderer: null, icon: null, label: null });
  return tokens;
});

console.log(`\nfound ${out.length} feedbackToken(s) in /feed/history:\n`);
for (const t of out) {
  const isPause = /pause watch history|turn on watch history/i.test(t.label || '');
  console.log(
    `${isPause ? '➡ PAUSE  ' : '         '}token=${t.token}  renderer=${t.renderer}  icon=${t.icon}  label="${t.label}"`
  );
}
console.log('');
await browser.close();
