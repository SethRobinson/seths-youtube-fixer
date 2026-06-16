// Recon Adapter B part 2 (READ-ONLY): find the per-item delete token + the
// WIZ params (at / f.sid / bl) in the page, so we can build the delete RPC.
import { connect } from './chrome-lib.mjs';

const { browser, context } = await connect();
const p = await context.newPage();
await p.goto('https://myactivity.google.com/product/youtube', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(6000);

const info = await p.evaluate(() => {
  const w = window;
  const wiz = w.WIZ_global_data || {};
  const out = {
    wizKeys: Object.keys(wiz).length,
    at: wiz['SNlM0e'] ? String(wiz['SNlM0e']).slice(0, 14) + '…' : null,
    fsid: wiz['FdrFJe'] || null,
    bl: wiz['cfb2h'] || null,
  };

  // How many delete-token-looking strings exist, and can we tie one to each item?
  const tokenRe = /AODP[A-Za-z0-9_-]{30,}/g;
  const html = document.documentElement.outerHTML;
  const allTokens = html.match(tokenRe) || [];
  out.tokensInHtml = allTokens.length;

  // For the first few delete buttons, walk ancestors and dump attributes that
  // might carry the token (jsdata / data-* / jsaction).
  const dels = [...document.querySelectorAll('button[aria-label^="Delete activity item"]')].slice(0, 3);
  out.buttons = dels.map((b) => {
    const attrsOf = (el) => {
      const o = {};
      for (const a of el.attributes) if (/jsdata|data-|jsaction|jslog|id/.test(a.name)) o[a.name] = a.value.slice(0, 80);
      return o;
    };
    let cur = b;
    const chain = [];
    for (let i = 0; i < 8 && cur; i++) {
      const t = (cur.outerHTML.match(tokenRe) || [])[0];
      chain.push({ depth: i, tag: cur.tagName, attrs: attrsOf(cur), tokenHere: t ? t.slice(0, 18) + '…' : null });
      if (t) break;
      cur = cur.parentElement;
    }
    return { label: (b.getAttribute('aria-label') || '').slice(0, 28), chain };
  });
  return out;
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
