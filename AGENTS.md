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
- **Feature 1a — DONE (capture + availability, dry-run clicks):** The MAIN-world bridge
  parses `ytInitialData` + hooks `/youtubei/v1/{browse,next,search}` responses to capture
  "Not interested" (`feedbackToken`, icon HIDE) and "Don't recommend channel" (icon REMOVE)
  tokens, keyed by video/channel in the SW cache (`syf.feedback`, 7-day TTL). On a watch
  page, Nah/Hate light up when a token is cached. **Clicks are DRY-RUN — nothing is POSTed
  yet.** Measure with `node scripts/measure-feedback.mjs`.
  - Coverage note: modern home cards are mostly `lockupViewModel` (no inline tokens), so only
    a subset of home videos yield tokens; coverage grows across surfaces (search, up-next).
    channelId isn't always in the renderer — video-level token is the reliable fallback.
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
- **UX:** grayed Nah/Hate buttons stay clickable — clicking a grayed one shows a toast explaining
  why it's unavailable (`showToast`). Buttons: Nah · Hate this channel · Wipe history · Find in
  comments · ℹ Info.
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
- `src/options/`, `src/popup/` — options page (API key) and toolbar popup.
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
