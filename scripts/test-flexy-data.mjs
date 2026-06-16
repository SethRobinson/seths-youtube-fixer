// Verify the LIVE data source for SPA nav: does ytd-watch-flexy.data (and/or the
// secondary-results renderer element) carry the CURRENT sidebar with feedback
// tokens, even when window.ytInitialData is stale?
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const w = await context.newPage();

await w.goto('https://www.youtube.com/watch?v=kJQP7kiw5Fk', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#secondary a[href*="/watch?v="]', { timeout: 15000 }).catch(() => {});
await wait(6000);

// hop once into SPA territory (where ytInitialData goes stale)
const u = w.url();
await w.evaluate(() => document.querySelector('#secondary yt-lockup-view-model a[href*="/watch?v="]')?.click());
await w.waitForFunction((x) => location.href !== x, u, { timeout: 12000 }).catch(() => {});
await wait(6000);

const r = await w.evaluate(() => {
  const firstDom = (() => {
    const a = document.querySelector('#secondary yt-lockup-view-model a[href*="/watch?v="], #secondary ytd-compact-video-renderer a[href*="/watch?v="]');
    const m = a?.href.match(/[?&]v=([\w-]{11})/);
    return m ? m[1] : null;
  })();

  const probeObj = (obj) => {
    if (!obj) return { present: false };
    let s = '';
    try { s = JSON.stringify(obj); } catch { return { present: true, stringifyFailed: true }; }
    return {
      present: true,
      bytes: s.length,
      hasFirstDom: firstDom ? s.includes(firstDom) : null,
      feedbackTokenCount: (s.match(/feedbackToken/g) || []).length,
      hasSecondaryResults: s.includes('secondaryResults'),
    };
  };

  const flexy = document.querySelector('ytd-watch-flexy');
  const secRenderer = document.querySelector('ytd-watch-next-secondary-results-renderer');
  // try a couple of property names polymer/lit use
  const flexyData = flexy && (flexy.data || flexy.__data || flexy.polymerController?.data);
  const secData = secRenderer && (secRenderer.data || secRenderer.__data);

  // also: does flexy.data expose a clean path to secondaryResults?
  let secPath = null;
  try {
    const d = flexy?.data;
    if (d?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results) secPath = 'contents.twoColumnWatchNextResults.secondaryResults.secondaryResults.results';
    else if (d?.contents?.twoColumnWatchNextResults?.secondaryResults) secPath = 'contents.twoColumnWatchNextResults.secondaryResults (other shape)';
  } catch {}

  return {
    locationV: new URL(location.href).searchParams.get('v'),
    firstDom,
    ytInitialDataStaleFirst: (() => { try { const m = JSON.stringify(window.ytInitialData?.contents?.twoColumnWatchNextResults?.secondaryResults || {}).match(/"(?:contentId|videoId)":"([\w-]{11})"/); return m ? m[1] : null; } catch { return null; } })(),
    flexyData: probeObj(flexyData),
    secRendererData: probeObj(secData),
    flexySecondaryPath: secPath,
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
