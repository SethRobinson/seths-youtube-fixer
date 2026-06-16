// Recon: find where YouTube stores "Not interested" / "Don't recommend channel"
// feedback tokens in the live signed-in Home page, from both ytInitialData and
// live card element polymer data. Read-only — submits nothing.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const page = await context.newPage();
await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
// give the grid time to render
await page.waitForTimeout(6000);

const report = await page.evaluate(() => {
  function labelOf(node) {
    try {
      if (node.text?.runs) return node.text.runs.map((r) => r.text).join('');
      if (node.text?.simpleText) return node.text.simpleText;
    } catch {}
    return '';
  }
  function findToken(node, d) {
    if (!node || typeof node !== 'object' || d > 6) return null;
    if (typeof node.feedbackToken === 'string') return node.feedbackToken;
    for (const k of Object.keys(node)) {
      const t = findToken(node[k], d + 1);
      if (t) return t;
    }
    return null;
  }
  // Collect menu-item-like nodes that carry a feedback token.
  function scan(root, label, out, seen) {
    const items = [];
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 40) return;
      if (seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach((v) => walk(v, d + 1));
      // a menu service item has .text and a .serviceEndpoint with a feedback token
      if (o.text && o.serviceEndpoint) {
        const tok = findToken(o.serviceEndpoint, 0);
        if (tok) {
          items.push({
            label: labelOf(o),
            icon: o.icon?.iconType || null,
            tokenLen: tok.length,
            tokenHead: tok.slice(0, 12),
            keysUnderServiceEndpoint: Object.keys(o.serviceEndpoint).slice(0, 6),
          });
        }
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    })(root, 0);
    out[label] = { count: items.length, sample: items.slice(0, 8) };
  }

  const out = {};
  scan(window.ytInitialData, 'ytInitialData', out, new WeakSet());

  // Live card elements (polymer expando .data is visible in MAIN world).
  const sel = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer';
  const cards = [...document.querySelectorAll(sel)];
  let withData = 0;
  let withToken = 0;
  const cardSeen = new WeakSet();
  const cardItems = [];
  for (const el of cards.slice(0, 40)) {
    const data = el.data;
    if (!data) continue;
    withData++;
    const before = cardItems.length;
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 30) return;
      if (cardSeen.has(o)) return;
      cardSeen.add(o);
      if (Array.isArray(o)) return o.forEach((v) => walk(v, d + 1));
      if (o.text && o.serviceEndpoint) {
        const tok = findToken(o.serviceEndpoint, 0);
        if (tok) cardItems.push({ label: labelOf(o), icon: o.icon?.iconType || null, tokenHead: tok.slice(0, 12) });
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    })(data, 0);
    if (cardItems.length > before) withToken++;
  }
  out.liveCards = {
    totalCardsInDom: cards.length,
    scanned: Math.min(cards.length, 40),
    withData,
    cardsYieldingTokens: withToken,
    sample: cardItems.slice(0, 10),
  };
  out.hasYtInitialData = !!window.ytInitialData;
  return out;
});

console.log(JSON.stringify(report, null, 2));
await page.close();
await browser.close();
