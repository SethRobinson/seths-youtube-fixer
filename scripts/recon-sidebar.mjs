// Do watch-page sidebar (up-next) videos carry inline "Not interested" (NI) and
// "Don't recommend channel" (DR) tokens, or only DR / neither? Read-only.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const p = await context.newPage();
await p.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(8000); // let the sidebar + /next load

const r = await p.evaluate(() => {
  const textOf = (t) =>
    t?.runs ? t.runs.map((x) => x.text).join('') : t?.simpleText || (typeof t?.content === 'string' ? t.content : '');
  const labelOf = (o) => (o?.title?.content || textOf(o?.text) || '').toLowerCase();
  const iconOf = (o) => o?.leadingImage?.sources?.[0]?.clientResource?.imageName || o?.icon?.iconType || '';
  const findFE = (o, d) => {
    if (!o || typeof o !== 'object' || d > 8) return null;
    if (o.feedbackEndpoint && typeof o.feedbackEndpoint.feedbackToken === 'string') return o.feedbackEndpoint;
    if (typeof o.feedbackToken === 'string') return o;
    for (const k of Object.keys(o)) {
      const r = findFE(o[k], d + 1);
      if (r) return r;
    }
    return null;
  };
  const classify = (container) => {
    const res = {};
    const seen = new WeakSet();
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 22 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
      const label = labelOf(o);
      const icon = iconOf(o);
      if (label || icon) {
        const fe = findFE(o, 0);
        if (fe && typeof fe.feedbackToken === 'string') {
          if (icon === 'HIDE' || label.includes('not interested')) res.ni = true;
          else if (icon === 'REMOVE' || label.includes("don't recommend") || label.includes('dont recommend')) res.dr = true;
          return;
        }
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    })(container, 0);
    return res;
  };

  const scan = (root) => {
    const out = { nodes: 0, withNI: 0, withDR: 0, sample: [] };
    const seen = new WeakSet();
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 45 || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach((x) => walk(x, d + 1));
      let vid, container, title;
      if (typeof o.videoId === 'string' && o.videoId.length === 11 && o.menu) {
        vid = o.videoId;
        container = o.menu;
        title = textOf(o.title);
      } else if (o.lockupViewModel && typeof o.lockupViewModel.contentId === 'string' && o.lockupViewModel.contentId.length === 11) {
        vid = o.lockupViewModel.contentId;
        container = o.lockupViewModel;
        title = o.lockupViewModel?.metadata?.lockupMetadataViewModel?.title?.content;
      }
      if (vid && container) {
        out.nodes++;
        const c = classify(container);
        if (c.ni) out.withNI++;
        if (c.dr) out.withDR++;
        if (out.sample.length < 10) out.sample.push({ vid, ni: !!c.ni, dr: !!c.dr, title: (title || '').slice(0, 28) });
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    })(root, 0);
    return out;
  };

  // sidebar lives under twoColumnWatchNextResults.secondaryResults
  const sec = window.ytInitialData?.contents?.twoColumnWatchNextResults?.secondaryResults;
  return { ytInitialDataAll: scan(window.ytInitialData || {}), secondaryOnly: sec ? scan(sec) : 'not found' };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
