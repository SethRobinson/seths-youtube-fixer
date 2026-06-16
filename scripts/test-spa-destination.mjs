// Reproduce Seth's exact flow: on a watch page, click a SIDEBAR video (SPA nav),
// and on the destination check (a) is it cached, (b) what does SYF_LOOKUP return,
// (c) are the Hate content / Hate channel buttons enabled.
import { connect, findExtensionId, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const id = await findExtensionId(context);
const ext = await context.newPage();
await ext.goto(`chrome-extension://${id}/options/options.html`);
await ext.evaluate(() => chrome.storage.local.remove('syf.feedback'));

const w = await context.newPage();
w.on('console', (m) => {
  if (m.text().includes('[SYF')) console.log('PAGE:', m.text());
});
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
await wait(9000); // be generous

const B = await w.evaluate(() => {
  const a = document.querySelector('#secondary a[href*="/watch?v="]');
  const m = a?.href.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
});
console.log('sidebar target B =', B);

// Is B cached before we click?
const lookupBefore = await ext.evaluate((v) => chrome.runtime.sendMessage({ type: 'SYF_LOOKUP', videoId: v }), B);
console.log('lookup(B) BEFORE click:', JSON.stringify({ nah: lookupBefore?.nah, hate: lookupBefore?.hate, hasNahToken: !!lookupBefore?.nahToken }));

// Click it (SPA nav).
await w.evaluate(() => document.querySelector('#secondary a[href*="/watch?v="]').click());
await w.waitForFunction((v) => location.href.includes(v), B, { timeout: 10000 }).catch(() => {});
await wait(6000);

const onPage = await w.evaluate(() => {
  const url = new URL(location.href).searchParams.get('v');
  const q = (a) => document.querySelector(`#syf-bar [data-action="${a}"]`);
  const st = (a) => {
    const b = q(a);
    return b ? { enabled: !b.disabled, state: b.dataset.state, label: b.textContent } : null;
  };
  return { urlVideoId: url, nah: st('nah'), hate: st('hate-channel') };
});
console.log('ON B PAGE: urlVideoId=', onPage.urlVideoId);
console.log('  nah button:', JSON.stringify(onPage.nah));
console.log('  hate button:', JSON.stringify(onPage.hate));

// What does the SW lookup return for B now?
const lookupAfter = await ext.evaluate((v) => chrome.runtime.sendMessage({ type: 'SYF_LOOKUP', videoId: v }), B);
console.log('lookup(B) AFTER nav:', JSON.stringify({ nah: lookupAfter?.nah, hate: lookupAfter?.hate, hasNahToken: !!lookupAfter?.nahToken, videoKnown: lookupAfter?.videoKnown }));

await browser.close();
