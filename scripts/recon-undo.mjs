// Recon: does YouTube's "Not interested" / "Don't recommend channel" feedback
// endpoint embed an UNDO token (e.g. under feedbackEndpoint.actions ->
// replaceEnclosingAction -> notification -> "Undo" button)? Read-only.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const page = await context.newPage();
await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const r = await page.evaluate(() => {
  function firstMenuItem(predicate) {
    let hit = null;
    const seen = new WeakSet();
    (function walk(o, d) {
      if (hit || !o || typeof o !== 'object' || d > 40) return;
      if (seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
      if (o.menuServiceItemRenderer && predicate(o.menuServiceItemRenderer)) {
        hit = o.menuServiceItemRenderer;
        return;
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    })(window.ytInitialData, 0);
    return hit;
  }
  function collectTokensWithLabels(node, d, out) {
    if (!node || typeof node !== 'object' || d > 18) return;
    if (typeof node.feedbackToken === 'string') {
      const label =
        node.defaultText?.runs?.map((x) => x.text).join('') ||
        node.text?.runs?.map((x) => x.text).join('') ||
        node.text?.simpleText ||
        '';
      out.push({ head: node.feedbackToken.slice(0, 14), label });
    }
    for (const k of Object.keys(node)) collectTokensWithLabels(node[k], d + 1, out);
  }
  function summarize(mi) {
    if (!mi) return null;
    const fe = mi.serviceEndpoint?.feedbackEndpoint;
    const tokens = [];
    collectTokensWithLabels(mi.serviceEndpoint, 0, tokens);
    return {
      label: mi.text?.runs?.map((x) => x.text).join('') || mi.text?.simpleText,
      icon: mi.icon?.iconType,
      feedbackEndpointKeys: fe ? Object.keys(fe) : null,
      hasActions: !!fe?.actions,
      tokensFound: tokens,
      actionsJson: JSON.stringify(fe?.actions || null).slice(0, 1500),
    };
  }
  return {
    notInterested: summarize(firstMenuItem((mi) => mi.icon?.iconType === 'HIDE')),
    dontRecommend: summarize(firstMenuItem((mi) => mi.icon?.iconType === 'REMOVE')),
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
