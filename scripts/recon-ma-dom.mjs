// READ-ONLY: dump the My Activity item DOM so we can tell a real watch TIMESTAMP
// apart from the video DURATION badge (both are "\d+:\d+"). Runs hl=en (AM/PM
// timestamps, easy to spot) and hl=fr (24-hour timestamps, the hard case).
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { browser, context } = await connect();
await reloadExtension(context);
await wait(1000);
const p = await context.newPage();

async function dump(hl) {
  await p.goto(`https://myactivity.google.com/product/youtube?hl=${hl}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelectorAll('[data-token][data-date]').length > 0, { timeout: 20000 }).catch(() => {});
  await wait(2500);
  const out = await p.evaluate(() => {
    const RE = /\d{1,2}:\d{2}|AM|PM|午前|午後|오전|오후/i;
    const containers = [...document.querySelectorAll('[data-token][data-date]')].slice(0, 4);
    const ancestry = (node, stop) => {
      const chain = [];
      let cur = node.parentElement;
      while (cur && cur !== stop && chain.length < 8) {
        const cls = (cur.className && typeof cur.className === 'string' ? cur.className : '').slice(0, 24);
        chain.push(cur.tagName.toLowerCase() + (cls ? '.' + cls.replace(/\s+/g, '.') : ''));
        cur = cur.parentElement;
      }
      return chain.join(' < ');
    };
    return containers.map((c, idx) => {
      const dataAttrs = {};
      for (const a of c.attributes) if (a.name.startsWith('data-')) dataAttrs[a.name] = a.value.slice(0, 30);
      const timeNodes = [];
      const tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        const t = (n.nodeValue || '').trim();
        if (!t || !RE.test(t)) continue;
        const pe = n.parentElement;
        timeNodes.push({
          text: t.slice(0, 40),
          parent: pe ? pe.tagName.toLowerCase() + (pe.getAttribute('aria-hidden') ? '[aria-hidden]' : '') : '?',
          inAnchor: !!(pe && pe.closest('a')),
          nearImg: !!(pe && (pe.closest('a')?.querySelector('img') || pe.parentElement?.querySelector('img'))),
          chain: ancestry(n, c),
        });
      }
      return { idx, dataAttrs, fullText: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), timeNodes };
    });
  });
  console.log(`\n================= hl=${hl} =================`);
  for (const item of out) {
    console.log(`\n— item #${item.idx}  data:`, JSON.stringify(item.dataAttrs));
    console.log(`  text: "${item.fullText}"`);
    for (const tn of item.timeNodes) {
      console.log(`   • "${tn.text}"  <${tn.parent}>  inAnchor=${tn.inAnchor} nearImg=${tn.nearImg}`);
      console.log(`       chain: ${tn.chain}`);
    }
  }
}

await dump('en');
await dump('fr');
await browser.close();
