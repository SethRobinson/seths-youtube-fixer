# AGENTS.md — Seth's YouTube Fixer

> **Single source of truth for any AI/agent working on this repo** (universal,
> cross-tool convention — Claude, Cursor, etc.). **Keep this file up to date**
> whenever status, architecture, commands, or decisions change — in the same change.
> Sensitive/login/secret info goes in **`AGENTS-secret.md`** (gitignored), not here —
> and keep that current too.

## What this is

A Manifest V3 Chromium extension (TypeScript + esbuild) adding power-user controls to
YouTube. Personal project; owner is Seth. Four features, on a button bar injected onto
the watch page:

1. **Nah** — submit YouTube's real *Not interested* feedback for the current video.
2. **Hate this channel** — submit YouTube's real *Don't recommend channel* feedback.
3. **Wipe history** — fast-delete recent YouTube activity via Google My Activity.
4. **Find in comments** — search all public comments/replies via the YouTube Data API.

Nah / Hate work by capturing YouTube's internal feedback endpoints from recommendation
cards and replaying them — **never fabricated**. Buttons stay disabled until a real
cached endpoint exists for that video/channel.

## Status

- **Phase 0 — DONE:** Scaffold + dynamic CDP test harness. 4-button bar injects on watch
  pages. Verified end-to-end via `npm run drive`.
- **Feature 1a — DONE (capture + availability, dry-run clicks):** The MAIN-world bridge reads the
  **live polymer element data** (`ytd-watch-flexy.data` / `ytd-browse.data` / `ytd-search.data`,
  scoped by `location.pathname`) + hooks `/youtubei/v1/{browse,next,search}` responses (scroll
  continuations) to capture "Not interested" (`feedbackToken`, icon HIDE) and "Don't recommend
  channel" (icon REMOVE) tokens, keyed by video/channel in the SW cache (`syf.feedback`, 7-day TTL;
  `unlimitedStorage` + LRU-capped at 2000 videos/2000 channels so it can't hit the 10 MB quota and
  silently drop captures). The SW keeps cache/log/settings **in memory** (no re-parse per lookup;
  invalidated on reset). The DR token is stored channel-level only (not duplicated in the video
  entry) → ~0.8 KB/video. `captureFrom` only pushes new/changed tuples to the SW (per-tick dedup vs
  `videoIndex`). Clicking a video link triggers a **click-time capture** of that exact video
  (`CAPTURE_VIDEO` → bridge `videoIndex`, falling back to the live element data) so fast clicks still
  cache the clicked video. On a watch page, Nah/Hate light up when a token is cached. **Clicks are
  DRY-RUN — nothing is POSTed yet.** Measure with `node scripts/measure-feedback.mjs`.
  - **Root-cause fix (2026-06-16): sidebar-clicked videos stayed gray.** `window.ytInitialData` is
    **frozen at the first full page load** — after an SPA navigation (clicking sidebar videos while
    watching) it never updates, *and* YouTube serves the new "watch next" data **with no `/next`
    request** we can hook (prefetched). So the old `captureFrom(ytInitialData)` tick only ever
    captured the *original* page's sidebar; every video that rotated in after the first hop was never
    cached. Reproduced at 3/5 hops, fixed to 15/15 by reading `ytd-watch-flexy.data` (the SPA-fresh
    source) instead. Regression tests: `scripts/test-hops-real.mjs` (multi-hop real-card clicks),
    `scripts/test-spa-data.mjs` (proves the staleness), `scripts/test-flexy-data.mjs` (proves the
    live source).
  - Coverage (fixed 2026-06-16): the extractor now handles BOTH classic (`videoId`+`menu`) and the
    new `lockupViewModel` cards (`contentId` + `rendererContext.commandContext.onTap.innertubeCommand
    .feedbackEndpoint`). Tokens are inline in the feed — no need to open menus (confirmed all 70 home
    lockups carry them). ~160 videos / ~118 channels captured per home browse+scroll (was ~12/3).
    Classify by icon `HIDE`/`REMOVE` or label; channelId = first `UC…`(24) string in the node.
- **Feature 1b — replay VALIDATED:** `POST /youtubei/v1/feedback` with the cached token works.
  Auth = `Authorization: SAPISIDHASH <ts>_<sha1(ts SAPISID origin)>` + `X-Goog-AuthUser`,
  `X-Origin`, innertube context/client from `ytcfg`. A home-feed token replayed on the watch
  page returned `feedbackResponses:[{isProcessed:true}]`. So same-session capture→replay is
  confirmed (cross-session/aged tokens still untested). Bridge exposes `submitFeedback()` and a
  `REPLAY` message handler; `window.__syfSubmitFeedback(token)` is the test hook
  (`scripts/validate-replay.mjs`).
  - **Undo caveat:** the "Not interested" response has NO undo token — only "Tell us why" reason
    tokens. There is no clean programmatic undo for watch-page Nah (real Undo lives in the feed's
    replacement card). Don't show a fake Undo; "Nah sent ✓" is the honest end state.
- **Feature 1 — DONE (submit + toggle + log + native capture):**
  - Click submits real feedback; **click again undoes it** (toggle). Undo works because the card's
    `feedbackEndpoint` embeds `…undoFeedbackEndpoint.undoToken`; POSTing that reverses the action
    (`isProcessed:true`). Captured + cached alongside the action token.
  - **Action log** (`syf.actionlog`, ≤1000 entries) records every action with type/source/video/
    undo token. The bar's **ℹ Info** button opens an in-page panel with per-row **Undo / Redo**.
  - **Native capture:** bridge hooks YouTube's own `/youtubei/v1/feedback` POSTs; if the token
    matches our captured index, it's logged `source:'native'` (undoable). Limitation: only matches
    videos captured classically — native actions on `lockupViewModel` cards can't be identified.
  - Verified net-neutral via `scripts/{test-toggle-log,test-native,test-undo,validate-replay}.mjs`.
  - NOTE: bridge exposes `window.__syfDebug` (tokenIndex peek) for tests — gate/remove before any
    wider distribution (a page script could read a cached feedback token).
- **UX:** grayed Hate-content/Hate-channel buttons stay clickable — clicking a grayed one shows a
  toast explaining why it's unavailable (`showToast`). Bar buttons: **Hate content** · **Hate
  channel** · **⏸ Pause history** · **Wipe history** · **Find in comments** · **ℹ Info**.
  ("Nah"/"Hate this channel" were renamed to "Hate content"/"Hate channel"; internal action ids
  stay `nah`/`hate-channel`.)
- **UX (2026-06-16):**
  - **⏸ Pause history / ▶ Resume history** — REAL inline toggle. Pausing/resuming watch history is
    a `feedbackToken` on the same `/youtubei/v1/feedback` endpoint as Nah/Hate. The bridge extracts
    the pause/resume token + state from `/feed/history`'s `ytInitialData` (`readHistoryInfo` →
    `HISTORY_INFO`). Bar → `SYF_HISTORY` → SW opens `/feed/history` in a bg tab → `SYF_HISTORY_DO`
    submits via the bridge → caches `settings.lastHistoryPaused` (drives the button label). Safety:
    if the token's gone (`no-token`), `showBackoff('history')` shows a "YouTube changed its code"
    notice with **Don't show again** (`settings.dismissedWarnings`).
  - **Wipe history** — quick in-page **presets** dialog; picking a window opens the slow
    scan/review/delete in a new tab (`wipe.html?minutes=N`) so it doesn't block viewing.
  - **Info** — opens **settings as an in-page dialog** (iframe of `options/options.html`, allowed by
    `web_accessible_resources` for youtube.com; CSP permits it). The options page holds: API key +
    help, Hide Shorts, feedback TTL, the **action log** (Undo/Redo via `SYF_RELAY_REPLAY` →
    `SYF_DO_REPLAY` relayed through a YouTube tab), **Reset data** (`SYF_RESET` clears
    `ALL_STORAGE_KEYS` incl. dismissed warnings), and **credits (Seth A. Robinson / rtsoft.com)**.
    (The standalone `src/log/` page was removed.)
  - **Find in comments** opens settings/options (with a toast) when no API key is set.
  - **Hide Shorts** setting toggles `html.syf-hide-shorts`; CSS hides Shorts shelves/cards/nav (live
    via `storage.onChanged`). Settings include `hideShorts`, `feedbackTtlDays`, `lastHistoryPaused`,
    `dismissedWarnings`. No current setting needs a page reload (all apply live).
- **Security & known residuals** (from the 2026-06-16 adversarial review; fixes landed for storage
  races, the debug globals, CSP, sender check, and transient-vs-permanent history backoff). Still
  open, low-risk for personal single-account English use — revisit before any wider distribution:
  - The MAIN-world bridge still does the authenticated `/youtubei/v1/feedback` POST and accepts a
    `to-page` `REPLAY` `postMessage` whose guard fields are page-forgeable. A script already running
    in the youtube.com MAIN world could trigger feedback writes (bounded to Nah/Hate/pause — not
    account takeover). Proper fix: nonce-gate the channel, or move submission to the isolated world
    (read SAPISID from `document.cookie` + `ytcfg` from the inline script).
  - History button label is driven by cached `lastHistoryPaused` (default = assume ON). The *action
    and toast are always correct* (the toggle reads live state from /feed/history first), but on a
    fresh install / after toggling via YouTube's own UI the pre-click label can be stale until the
    first toggle. A live state read on bar build would fix it but means opening /feed/history.
  - History token extraction matches English labels (`pause/turn on watch history`) — non-English
    locales fall through to the "control gone" backoff.
  - Settings dialog frames `options.html` from youtube.com (needed for the feature); a malicious
    youtube.com page could clickjack the one-click Undo/Redo (Reset is behind a native confirm). The
    CSP blocks non-youtube origins.
  - `relayReplay` targets the first open youtube.com tab — a multi-account user could submit a token
    against the wrong account.
- **Feature 2 — Wipe history (scan + UI DONE; delete built, NOT yet validated):**
  - `src/content/myactivity.ts` runs on myactivity.google.com: pairs each "Delete activity item"
    button with the timestamp preceding it in document order (handles grouped times), filters to a
    window. SW (`handleWipe`) opens a fresh background My Activity tab, relays `SYF_MA_SCAN`/
    `SYF_MA_DELETE`, then closes the tab. Watch-page dialog: presets (15/30/60/120 + custom) →
    **scan → review the exact item list + window times → red Delete** (gated). Scan verified
    (`test-wipe-scan`, `test-wipe-ui`). **The irreversible per-item delete-click is NOT yet
    exercised** — validate on a tiny window with the user's OK before trusting it.
  - Caveat: timestamps are minute-precision, assumed "today" (yesterday if the time is in the
    future). Deletion re-scans after each click (DOM mutates).
  - Adapter A (UI click) is dead: the confirm "Delete" is a Material Web button (`VfPpkd-LgbsSe`)
    requiring a TRUSTED event, which content scripts can't dispatch (verified: `.click()` and full
    pointer sequences leave the count unchanged).
  - **Adapter B — RPC delete (IMPLEMENTED, chosen by Seth; live-delete NOT yet verified):**
    `myactivity.ts` deletes via `POST /_/FootprintsMyactivityUi/data/batchexecute?rpcids=TmdDAd`
    with `f.req=[[["TmdDAd","[[null,[\"youtube\"]],[\"<token>\"]]",null,"generic"]]]&at=<at>`.
    Per-item `<token>` = the `data-token` attr on the item's `<c-wiz>` ancestor (also `data-date`);
    `at`/`f.sid`/`bl` parsed from the inline `WIZ_global_data` script (`SNlM0e`/`FdrFJe`/`cfb2h`).
    Same-origin authed fetch — no trusted-event problem. Captured from a real delete via
    `scripts/recon-ma-rpc(2).mjs`.
  - **Live validation INCONCLUSIVE this session (external timing, not a code issue):** fresh
    watches don't propagate to My Activity within ~11 min (polled), and the authorized recent
    windows were empty (this session's test-watches were already deleted during debugging — proof
    that deletion works via *some* path; trusted real-clicks definitely worked). The RPC replicates
    the captured real request byte-for-byte and runs without error, so confidence is high, but the
    RPC path specifically is not independently confirmed. **Finalize on first real use:** wipe
    recent (already-propagated) activity via the UI, review the list, Delete, and confirm the count
    drops. The review-before-delete UI makes this safe to do for real.
- **Open / next options:** validate the real delete (small window); Feature 3 — Comment search
  (needs API key); more Feature 1 coverage (lockupViewModel), Hate end-to-end, aged replay.

Dev/test scripts in `scripts/`: recon-feedback, recon-undo, recon-myactivity(2), measure-feedback,
validate-replay, test-click, test-undo, test-toggle-log, test-native, test-toast, test-wipe-scan,
test-wipe-ui, debug-ma, diag.

## Layout

- `src/manifest.json` — MV3 manifest.
- `src/background/service-worker.ts` — background SW (message router, storage).
- `src/content/youtube.ts` — isolated-world content script: SPA-nav detection, bar injection.
- `src/content/page-bridge.ts` — MAIN-world script: reads ytInitialData/ytcfg, session feedback POSTs.
- `src/content/styles.css` — bar styles.
- `src/options/`, `src/popup/` — options page (API key, hide-shorts, TTL) and toolbar popup.
- `src/wipe/`, `src/log/` — standalone Wipe-history and action-log pages (opened in new tabs).
- `src/common/messages.ts` — shared messages/types/settings.
- `scripts/` — esbuild build + CDP harness (`chrome-lib`, `setup`, `drive`, `reload`, `diag`).
- `test/` — Playwright (`fixtures.ts` attaches over CDP; `smoke.spec.ts`).

## Commands

- `npm run build` / `npm run watch` — bundle `src/` → `dist/`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run setup` — ONE-TIME: open dev profile to Load unpacked + sign in (see below).
- `npm run reload` — rebuild + hot-reload the live extension.
- `npm run drive` — rebuild + reload + smoke (injects bar, screenshots `test-results/`).
- `npm test` — rebuild + reload + full Playwright suite.

## Critical: how dynamic testing works (do NOT re-derive this)

Chrome 149 stable **hard-blocks the `--load-extension` command-line switch** — the
`DisableLoadExtensionCommandLineSwitch` escape hatch was removed in Chrome 142. Verified
empirically and by research (2026-06). **There is no flag fix on branded Chrome**; do not
waste time trying `launchPersistentContext({args:['--load-extension']})`.

Instead:
- A dedicated **`.test-profile/`** (gitignored) has `dist/` loaded ONCE via the
  chrome://extensions "Load unpacked" UI. It persists and auto-reloads from `dist/` every
  launch, and also holds Seth's signed-in YouTube session.
- `scripts/chrome-lib.mjs` `ensureChrome()` spawns real Chrome with that profile +
  `--remote-debugging-port=9222`; tests/scripts attach via `chromium.connectOverCDP`.
- Reload-after-rebuild calls `chrome.runtime.reload()` in the service worker (MV3 SW
  suspends after ~30s idle; fallback = the chrome://extensions reload button).
- **Headed only** (branded Chrome can't load extensions headless); single worker.

Env overrides: `SYF_PROFILE`, `SYF_CDP_PORT` (9222), `SYF_CHROME` (chrome.exe path).
Current dev extension ID: `ekmnapichhpgnidfdfjloebjcfpaanpo` (stable while `dist/` path
is unchanged). If `.test-profile/` is ever wiped, re-run `npm run setup` and Load unpacked.

## Conventions & rules

- TypeScript, strict. esbuild bundles each entry as IIFE (content scripts can't be ESM).
- No telemetry, no third-party servers; all data stays local. Never store Google
  cookies/session tokens/credentials. Never fabricate YouTube feedback. These are product
  requirements, not nice-to-haves.

## Maintaining these files

Whenever the project changes, update **this file** alongside the code change. Put any
credential/key/account detail in **`AGENTS-secret.md`** (gitignored) and keep it current.
