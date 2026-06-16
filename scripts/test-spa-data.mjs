// On SPA watch->watch nav: (1) does window.ytInitialData update to the new video,
// or stay stale? (2) what network calls actually fire? (3) where does the live
// sidebar data live if not in ytInitialData? This decides the capture fix.
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const w = await context.newPage();
const urls = [];
await w.addInitScript(() => {
  window.__urls = [];
  const re = /youtubei\/v1\/(next|browse|player|reel_watch)/;
  const of = window.fetch;
  window.fetch = function (...a) { try { const u = typeof a[0] === 'string' ? a[0] : a[0]?.url; if (u && re.test(u)) window.__urls.push('fetch:' + u.split('?')[0].split('/v1/')[1]); } catch {} return of.apply(this, a); };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { try { if (typeof u === 'string' && re.test(u)) window.__urls.push('xhr:' + u.split('?')[0].split('/v1/')[1]); } catch {} return oo.call(this, m, u, ...r); };
});

const probe = () =>
  w.evaluate(() => {
    const yid = window.ytInitialData;
    const curEndpoint = yid?.currentVideoEndpoint?.watchEndpoint?.videoId;
    // first sidebar id inside ytInitialData secondaryResults
    let firstInData = null;
    try {
      const sec = JSON.stringify(yid?.contents?.twoColumnWatchNextResults?.secondaryResults || {});
      const m = sec.match(/"(?:contentId|videoId)":"([\w-]{11})"/);
      firstInData = m ? m[1] : null;
    } catch {}
    // first sidebar id in the live DOM
    const a = document.querySelector('#secondary yt-lockup-view-model a[href*="/watch?v="], #secondary ytd-compact-video-renderer a[href*="/watch?v="]');
    const dm = a?.href.match(/[?&]v=([\w-]{11})/);
    const firstInDom = dm ? dm[1] : null;
    // does the flexy element hold fresh data?
    const flexy = document.querySelector('ytd-watch-flexy');
    let flexyHasData = false;
    try { flexyHasData = !!(flexy && flexy.data); } catch {}
    return {
      locationV: new URL(location.href).searchParams.get('v'),
      ytInitialDataCurrentVideo: curEndpoint,
      firstSidebarInYtInitialData: firstInData,
      firstSidebarInDOM: firstInDom,
      dataMatchesDom: firstInData === firstInDom,
      flexyHasData,
      netSinceLoad: window.__urls.slice(),
    };
  });

await w.goto('https://www.youtube.com/watch?v=kJQP7kiw5Fk', { waitUntil: 'domcontentloaded' });
await w.waitForSelector('#secondary a[href*="/watch?v="]', { timeout: 15000 }).catch(() => {});
await wait(7000);
console.log('--- after FULL LOAD ---');
console.log(JSON.stringify(await probe(), null, 2));

// hop twice via SPA
for (let i = 1; i <= 2; i++) {
  const u = w.url();
  await w.evaluate(() => {
    const a = document.querySelector('#secondary yt-lockup-view-model a[href*="/watch?v="], #secondary ytd-compact-video-renderer a[href*="/watch?v="]');
    a?.click();
  });
  await w.waitForFunction((x) => location.href !== x, u, { timeout: 12000 }).catch(() => {});
  await wait(6000);
  console.log(`\n--- after SPA HOP ${i} ---`);
  console.log(JSON.stringify(await probe(), null, 2));
}

await browser.close();
