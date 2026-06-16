// Validate the inline pause approach: extract the pause/resume feedbackToken from
// /feed/history, submit it via our bridge (__syfSubmitFeedback), confirm the state
// flips, then flip back (net-neutral).
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const p = await context.newPage();

async function readState() {
  await p.goto('https://www.youtube.com/feed/history', { waitUntil: 'domcontentloaded' });
  await wait(4000);
  await p.waitForFunction(() => typeof window.__syfSubmitFeedback === 'function', { timeout: 10000 }).catch(() => {});
  return p.evaluate(() => {
    const textOf = (t) =>
      t?.runs ? t.runs.map((x) => x.text).join('') : t?.simpleText || (typeof t?.content === 'string' ? t.content : '');
    const ctrl = [...document.querySelectorAll('button, a, yt-button-shape')].find((e) =>
      /pause watch history|turn on watch history/i.test(e.textContent || '')
    );
    const state = ctrl ? (ctrl.textContent || '').trim() : '?';
    let token = null;
    const seen = new WeakSet();
    (function walk(o) {
      if (token || !o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach(walk);
      const txt = (textOf(o.text) || textOf(o.title) || textOf(o.label) || '').trim();
      if (/^(pause watch history|turn on watch history)$/i.test(txt)) {
        const s2 = new WeakSet();
        (function dig(n, d) {
          if (token || !n || typeof n !== 'object' || d > 14 || s2.has(n)) return;
          s2.add(n);
          if (typeof n.feedbackToken === 'string') {
            token = n.feedbackToken;
            return;
          }
          for (const k of Object.keys(n)) dig(n[k], d + 1);
        })(o, 0);
      }
      for (const k of Object.keys(o)) walk(o[k]);
    })(window.ytInitialData || {});
    return { state, token };
  });
}

const s1 = await readState();
console.log('STATE1:', s1.state, '| token:', s1.token ? s1.token.slice(0, 14) + '…' : 'NONE');
if (!s1.token) {
  console.log('No pause/resume token found.');
  await browser.close();
  process.exit(1);
}
const r1 = await p.evaluate((t) => window.__syfSubmitFeedback(t), s1.token);
console.log('submit1: ok=' + r1.ok + ' status=' + r1.status);
await wait(1500);

const s2 = await readState();
console.log('STATE2:', s2.state, '| flipped:', s2.state !== s1.state);

if (s2.token) {
  const r2 = await p.evaluate((t) => window.__syfSubmitFeedback(t), s2.token);
  console.log('submit2: ok=' + r2.ok);
  await wait(1500);
}
const s3 = await readState();
console.log('STATE3:', s3.state, '| restored to original:', s3.state === s1.state);

await browser.close();
