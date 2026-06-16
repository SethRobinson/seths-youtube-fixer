// Click through several sidebar videos in a row (like Seth) and check the buttons
// at each hop. Latest code, fresh tab.
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);

const w = await context.newPage();
await w.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });

async function hop(n) {
  await wait(7000); // let the sidebar capture
  const before = w.url();
  const clicked = await w.evaluate(() => {
    const a = document.querySelector('#secondary a[href*="/watch?v="]');
    if (!a) return null;
    const m = a.href.match(/[?&]v=([\w-]{11})/);
    a.click();
    return m ? m[1] : null;
  });
  await w.waitForFunction((u) => location.href !== u, before, { timeout: 10000 }).catch(() => {});
  await wait(5000);
  const s = await w.evaluate(() => {
    const q = (a) => {
      const x = document.querySelector(`#syf-bar [data-action="${a}"]`);
      return x ? `${x.dataset.state}${x.disabled ? '/disabled' : ''}` : 'no-button';
    };
    return { v: new URL(location.href).searchParams.get('v'), nah: q('nah'), hate: q('hate-channel') };
  });
  console.log(`hop ${n}: clicked=${clicked} now=${s.v} nah=${s.nah} hate=${s.hate}`);
  await w.screenshot({ path: `test-results/hop-${n}.png` });
}

await hop(1);
await hop(2);
await hop(3);
await browser.close();
