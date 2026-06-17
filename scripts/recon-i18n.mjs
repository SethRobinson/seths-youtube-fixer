// READ-ONLY i18n recon. Renders /feed/history and My Activity in ja/fr/de/es/ko
// via the NON-persistent ?hl= UI override, then runs our ACTUAL parsing logic
// (mirrored from src/content/page-bridge.ts + src/content/myactivity.ts) against
// the live localized DOM/data. Toggles NOTHING, deletes NOTHING — pure read.
//
//   node scripts/recon-i18n.mjs
import { connect, reloadExtension } from './chrome-lib.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const LANGS = [
  ['en', 'English (baseline)'],
  ['ja', 'Japanese'],
  ['fr', 'French'],
  ['de', 'German'],
  ['es', 'Spanish'],
  ['ko', 'Korean'],
];

const { browser, context } = await connect();
await reloadExtension(context);
await wait(1500);
const p = await context.newPage();

// ── /feed/history: does our token extraction find the pause/resume control? ──
async function historyProbe(hl) {
  await p.goto(`https://www.youtube.com/feed/history?hl=${hl}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!document.querySelector('ytd-browse')?.data, { timeout: 15000 }).catch(() => {});
  await wait(2500);
  return p.evaluate(() => {
    const textOf = (t) =>
      t?.runs ? t.runs.map((r) => r.text).join('') : t?.simpleText || (typeof t?.content === 'string' ? t.content : '');
    const data = document.querySelector('ytd-browse')?.data || window.ytInitialData;
    if (!data) return { ok: false, reason: 'no-data' };

    // (A) English label path — verbatim from page-bridge.ts
    let token = null,
      paused = null,
      viaEnglish = false;
    const seen = new WeakSet();
    (function walk(o) {
      if (token || !o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (Array.isArray(o)) return o.forEach(walk);
      const label = (textOf(o.text) || textOf(o.title) || (typeof o.content === 'string' ? o.content : '') || '').trim();
      if (/^pause watch history$/i.test(label) || /^turn on watch history$/i.test(label)) {
        paused = /^turn on/i.test(label);
        viaEnglish = true;
        const s2 = new WeakSet();
        (function dig(n, d) {
          if (token || !n || typeof n !== 'object' || d > 14 || s2.has(n)) return;
          s2.add(n);
          if (typeof n.feedbackToken === 'string') return void (token = n.feedbackToken);
          for (const k of Object.keys(n)) dig(n[k], d + 1);
        })(o, 0);
      }
      for (const k of Object.keys(o)) walk(o[k]);
    })(data);

    // (B) Structural fallback — verbatim from page-bridge.ts (icon-based).
    function findHistoryToggleByIcon(d0) {
      let tk = null,
        pz = null;
      const sn = new WeakSet();
      (function walk(o, d, icon) {
        if (tk || !o || typeof o !== 'object' || d > 40 || sn.has(o)) return;
        sn.add(o);
        if (Array.isArray(o)) return void o.forEach((x) => walk(x, d + 1, icon));
        const here = String(o.icon?.iconType || o.defaultIcon?.iconType || o.iconType || '').toUpperCase();
        if (here) icon = here;
        const ft =
          o.feedbackEndpoint && typeof o.feedbackEndpoint.feedbackToken === 'string'
            ? o.feedbackEndpoint.feedbackToken
            : typeof o.feedbackToken === 'string'
              ? o.feedbackToken
              : null;
        if (ft) {
          if (/PAUSE/.test(icon)) return void ((tk = ft), (pz = false));
          if (/PLAY|RESUME/.test(icon)) return void ((tk = ft), (pz = true));
        }
        for (const k of Object.keys(o)) walk(o[k], d + 1, icon);
      })(d0, 0, '');
      return { token: tk, paused: pz };
    }
    // Compute the structural path INDEPENDENTLY (always), so we can confirm it
    // agrees with the proven English path. The /feed/history data structure is the
    // same in every language (only label TEXT differs), so agreement here proves
    // the fallback will find the right token in a localized page too.
    const struct = findHistoryToggleByIcon(data);
    void viaEnglish;

    const ctrl =
      [...document.querySelectorAll('button, a, yt-button-shape, tp-yt-paper-toggle-button')]
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean)
        .find((t) => /pause|resume|turn on|履歴|verlauf|historique|historial|기록/i.test(t)) || '(not found)';

    return {
      ok: true,
      englishToken: token,
      englishPaused: paused,
      structuralToken: struct.token,
      structuralPaused: struct.paused,
      agree: !!token && token === struct.token,
      control: ctrl.slice(0, 50),
    };
  });
}

// ── My Activity: does token-based detection + locale time parsing work? ──
async function myActivityProbe(hl) {
  await p.goto(`https://myactivity.google.com/product/youtube?hl=${hl}`, { waitUntil: 'domcontentloaded' });
  await p
    .waitForFunction(() => document.querySelectorAll('[data-token][data-date]').length > 0, { timeout: 20000 })
    .catch(() => {});
  await wait(2500);
  return p.evaluate(() => {
    // mirrored from myactivity.ts
    const MERIDIEM = '(?:AM|PM|午前|午後|오전|오후)';
    const MER_RE = new RegExp(MERIDIEM, 'i');
    const CLOCK_RE = /(\d{1,2}):(\d{2})/;
    const timeTextOf = (s) => {
      const m = s.trim().match(/^(?:(?:午前|午後|오전|오후)\s*)?\d{1,2}:\d{2}(?:\s*(?:AM|PM))?(?=$|[\s•·.,;])/i);
      return m ? m[0].trim() : null;
    };
    const parseTimeOfDay = (s) => {
      const cm = s.match(CLOCK_RE);
      if (!cm) return null;
      let h = parseInt(cm[1], 10);
      const min = parseInt(cm[2], 10);
      if (h > 23 || min > 59) return null;
      const mer = (s.match(MER_RE)?.[0] || '').toUpperCase();
      if ((mer === 'PM' || mer === '午後' || mer === '오후') && h !== 12) h += 12;
      if ((mer === 'AM' || mer === '午前' || mer === '오전') && h === 12) h = 0;
      return { h, min };
    };
    const tokenFor = (btn) => {
      let cur = btn;
      for (let i = 0; i < 12 && cur; i++) {
        if (cur.hasAttribute?.('data-token')) return { token: cur.getAttribute('data-token'), date: cur.getAttribute('data-date') };
        cur = cur.parentElement;
      }
      return { token: null, date: null };
    };
    const titleOf = (btn) => {
      const al = btn.getAttribute('aria-label') || '';
      if (al.startsWith('Delete activity item')) return al.replace(/^Delete activity item\s*/, '').trim();
      const card = btn.closest('[data-token]') || btn.parentElement;
      return ((card?.textContent || '').replace(/\s+/g, ' ').trim() || al || '(item)').slice(0, 80);
    };
    const ownTime = (btn) => {
      const container = btn.closest('[data-token]');
      if (!container) return null;
      const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        if (n.parentElement && n.parentElement.closest('a')) continue;
        const t = timeTextOf(n.nodeValue || '');
        if (t) return t;
      }
      return null;
    };
    function collect() {
      const out = [];
      let lastTime = null;
      const byToken = new Map();
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node;
      while ((node = tw.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.parentElement && node.parentElement.closest('a')) continue; // skip thumbnail duration
          const t = timeTextOf(node.nodeValue || '');
          if (t) lastTime = t;
        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BUTTON') {
          const { token, date } = tokenFor(node);
          if (!token) continue;
          const ex = byToken.get(token);
          if (ex) {
            if (node.getAttribute('aria-label')?.startsWith('Delete activity item')) ex.title = titleOf(node);
            continue;
          }
          const timeText = ownTime(node) ?? lastTime;
          const item = { title: titleOf(node), timeText, token, date, tod: timeText ? parseTimeOfDay(timeText) : null };
          byToken.set(token, item);
          out.push(item);
        }
      }
      return out;
    }

    const items = collect();
    const allAria = [...new Set([...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')).filter(Boolean))];
    const englishAriaMatches = allAria.some((a) => a.startsWith('Delete activity item'));
    // a couple of token-bearing buttons' aria-labels = the localized "delete" string
    const deleteAria = [...document.querySelectorAll('button[aria-label]')]
      .filter((b) => tokenFor(b).token)
      .map((b) => b.getAttribute('aria-label'))
      .filter(Boolean);

    return {
      tokenItems: items.length,
      parsedTimes: items.filter((i) => i.tod).length,
      sampleTimes: [...new Set(items.map((i) => i.timeText).filter(Boolean))].slice(0, 6),
      sampleParsed: items.slice(0, 3).map((i) => ({ time: i.timeText, tod: i.tod, title: (i.title || '').slice(0, 24) })),
      oldEnglishAriaMatched: englishAriaMatches,
      sampleDeleteAria: [...new Set(deleteAria)].slice(0, 3).map((a) => a.slice(0, 46)),
    };
  });
}

console.log('\n############ i18n LIVE RECON (read-only) ############\n');
for (const [hl, name] of LANGS) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`### ${name}  (hl=${hl})`);
  try {
    const h = await historyProbe(hl);
    if (h.ok)
      console.log(
        `  PAUSE HISTORY : english=${h.englishToken ? 'tok' : '—'}(paused=${h.englishPaused})  structural=${h.structuralToken ? 'tok' : '—'}(paused=${h.structuralPaused})  match=${h.agree ? 'YES ✅' : 'NO ❌'}  | "${h.control}"`
      );
    else console.log(`  PAUSE HISTORY : (${h.reason})`);
  } catch (e) {
    console.log('  PAUSE HISTORY : ERROR', String(e).slice(0, 120));
  }
  try {
    const m = await myActivityProbe(hl);
    console.log(
      `  WIPE HISTORY  : items=${m.tokenItems}  times-parsed=${m.parsedTimes}/${m.tokenItems}  oldEnglishAria=${m.oldEnglishAriaMatched ? 'matched' : 'MISSED (localized) ❌→now token-based ✅'}`
    );
    console.log(`                  localized delete aria: ${JSON.stringify(m.sampleDeleteAria)}`);
    console.log(`                  sample times: ${JSON.stringify(m.sampleTimes)}`);
    console.log(`                  parsed: ${JSON.stringify(m.sampleParsed)}`);
  } catch (e) {
    console.log('  WIPE HISTORY  : ERROR', String(e).slice(0, 120));
  }
  console.log('');
}
console.log('############ done ############\n');

await browser.close();
