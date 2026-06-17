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

1. **Less like this** — submit YouTube's real *Not interested* feedback for the current video.
2. **Don't recommend channel** — submit YouTube's real *Don't recommend channel* feedback.
3. **Wipe history** — fast-delete recent YouTube activity via Google My Activity.
4. **Find in comments** — opens a separate two-pane window: search every public comment/reply on the
   current video via the YouTube Data API (top), click a match to open the real YouTube page at that
   comment (bottom) and Like/Reply natively. (DONE — see Feature 3 in Status.)

The two feedback buttons work by capturing YouTube's internal feedback endpoints from
recommendation cards and replaying them — **never fabricated**. They stay grayed (but still
clickable, to explain why via a toast) until a real cached endpoint exists for that
video/channel. **User-facing labels have changed over time** (Nah → Hate content → **Less like
this**; Hate this channel → Hate channel → **Don't recommend channel**), but the **internal action
ids stay `nah` / `hate-channel`** and the cache/log keys are unchanged.

## Status

- **Phase 0 — DONE:** Scaffold + dynamic CDP test harness. Button bar injects on watch
  pages. Verified end-to-end via `npm run drive`.
- **Feature 1a — DONE (capture + availability, dry-run clicks):** The MAIN-world bridge reads the
  **live polymer element data** (`ytd-watch-flexy.data` / `ytd-browse.data` / `ytd-search.data`,
  scoped by `location.pathname`) + hooks `/youtubei/v1/{browse,next,search}` responses (scroll
  continuations) to capture "Not interested" (`feedbackToken`, icon HIDE) and "Don't recommend
  channel" (icon REMOVE) tokens, keyed by video/channel in the SW cache (`syf.feedback`, 7-day TTL).
  Because the manifest has `unlimitedStorage` there is **no** 10 MB `storage.local` quota, so the cache
  is bounded only by a **user-configurable** LRU cap (`settings.maxCacheVideos`, default **10,000**,
  configurable **100–50,000** in the options page — applied to BOTH the video and channel maps) plus a
  **50 MB** byte backstop (`DEFAULT_CACHE_CAP`/`MIN_CACHE_CAP`/`MAX_CACHE_CAP`/`MAX_FEEDBACK_BYTES` in
  `common/feedback.ts`, shared with the options UI) — both just keep load/save fast. Lowering the cap
  evicts immediately (on `SYF_PATCH_SETTINGS`), not just on the next capture. The SW keeps cache/log/settings **in memory** (no
  re-parse per lookup; invalidated on reset). Cache **writes are throttled (≤ once/2 s) and coalesced**,
  and `mergeCapture` **skips no-op re-sightings** (only a genuinely new/changed token flags a write), so
  a scroll burst (~160 videos) is a single write — it no longer rewrites the whole blob on every capture.
  The DR token is stored channel-level only (not duplicated in the video entry) → ~0.8 KB/video.
  `captureFrom` only pushes new/changed tuples to the SW (per-tick dedup vs
  `videoIndex`). Clicking a video link triggers a **click-time capture** of that exact video
  (`CAPTURE_VIDEO` → bridge `videoIndex`, falling back to the live element data) so fast clicks still
  cache the clicked video. On a watch page, the two feedback buttons light up when a token is
  cached. **Clicks are DRY-RUN — nothing is POSTed yet.** Measure with `node scripts/measure-feedback.mjs`.
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
    tokens. There is no clean programmatic undo for the watch-page action *from the response itself*
    (real Undo lives in the feed's replacement card). Don't show a fake Undo; the toggled "✓" state
    (e.g. "Less like this ✓") is the honest end state. (Toggle-undo still works — see Feature 1 — via
    the `undoToken` captured from the card's `feedbackEndpoint`, not from the submit response.)
- **Feature 1 — DONE (submit + toggle + log + native capture):**
  - Click submits real feedback; **click again undoes it** (toggle). Undo works because the card's
    `feedbackEndpoint` embeds `…undoFeedbackEndpoint.undoToken`; POSTing that reverses the action
    (`isProcessed:true`). Captured + cached alongside the action token.
  - **Action log** (`syf.actionlog`, ≤1000 entries) records every action with type/source/video/
    channel/undo token. The bar's **ℹ Info** button opens an in-page panel with per-row **Undo /
    Redo**. Each row shows the **video title** (links → the video) on one line and the **channel
    name** (links → `/channel/<id>`) below it; both open in a new tab. `channelName`/`channelId`
    were already captured per entry (from the player's `videoDetails.author`/`channelId`, or the
    capture tuple for native actions) — surfacing them needed no cache/log format change.
  - **Native capture:** bridge hooks YouTube's own `/youtubei/v1/feedback` POSTs; if the token
    matches our captured index, it's logged `source:'native'` (undoable). Limitation: only matches
    videos captured classically — native actions on `lockupViewModel` cards can't be identified.
  - Verified net-neutral via `scripts/{test-toggle-log,test-native,test-undo,validate-replay}.mjs`.
  - NOTE: bridge exposes `window.__syfDebug` (tokenIndex peek) for tests — gate/remove before any
    wider distribution (a page script could read a cached feedback token).
- **UX:** grayed "Less like this"/"Don't recommend channel" buttons stay clickable — clicking a
  grayed one shows a toast explaining why it's unavailable (`showToast`). Bar buttons: **Less like
  this** · **Don't recommend channel** · **⏸ Pause history** · **Wipe history** · **Find in
  comments** · **ℹ Info**. (See above for the label history; internal ids stay `nah`/`hate-channel`.)
- **UX (bar layout, 2026-06-16):** the bar is a single **non-wrapping row** with **no brand label**
  (the old "Seth's YouTube Fixer" text was removed). Buttons **auto-scale down to stay on one row**
  as the watch column narrows: `.syf-bar` is a `container-type: inline-size` query container and
  `.syf-btn` sizes its `font-size`/`padding` with `clamp(min, …cqi, max)` off the bar's width (caps
  at the comfortable desktop size, shrinks toward the min on narrow columns). The product name now
  appears only on the **ℹ Info** tooltip and inside the Info dialog (options page `<h1>` + footer).
- **UX (2026-06-16):**
  - **⏸ Pause history / ▶ Resume history** — REAL inline toggle. Pausing/resuming watch history is
    a `feedbackToken` on the same `/youtubei/v1/feedback` endpoint as the two feedback buttons. The bridge extracts
    the pause/resume token + state from `/feed/history`'s `ytInitialData` (`readHistoryInfo` →
    `HISTORY_INFO`). Bar → `SYF_HISTORY` → SW opens `/feed/history` in a bg tab → `SYF_HISTORY_DO`
    submits via the bridge → caches `settings.lastHistoryPaused` (drives the button label). Safety:
    if the token's gone (`no-token`), `showBackoff('history')` shows a "YouTube changed its code"
    notice with **Don't show again** (`settings.dismissedWarnings`).
  - **Wipe history** — quick in-page **presets** dialog; picking a window opens the slow
    scan/review/delete in a new tab (`wipe.html?minutes=N`) so it doesn't block viewing.
  - **Info** — opens **settings as an in-page dialog** (iframe of `options/options.html`, allowed by
    `web_accessible_resources` for youtube.com; CSP permits it). The options page holds: API key +
    help, Hide Shorts, feedback TTL, **max cached videos**, the **action log** (Undo/Redo via `SYF_RELAY_REPLAY` →
    `SYF_DO_REPLAY` relayed through a YouTube tab), **Reset data** (`SYF_RESET` clears
    `ALL_STORAGE_KEYS` incl. dismissed warnings), and **credits (Seth A. Robinson / rtsoft.com)**.
    (The standalone `src/log/` page was removed.)
  - **Settings auto-save (2026-06-17):** the options page has **no Save button** — each field patches
    via `SYF_PATCH_SETTINGS` the moment it's committed (checkboxes on `change`/toggle; number/text
    fields on `change` = blur/Enter, clamped on commit so editing doesn't fight you mid-typing and
    lowering the cache cap evicts only once; the API key also gets a debounced `input` backstop so a
    paste-then-close-the-dialog still persists). A small "✓ Saved" toast confirms each write; a
    "Changes are saved automatically." subtitle sits under the `<h1>`. The old bottom save card was
    removed.
  - **Find in comments** opens settings/options (with a toast) when no API key is set.
  - **Hide Shorts** setting toggles `html.syf-hide-shorts`; CSS hides Shorts shelves/cards/nav (live
    via `storage.onChanged`). Settings include `hideShorts`, `feedbackTtlDays`, `maxCacheVideos`,
    `lastHistoryPaused`, `dismissedWarnings`. No current setting needs a page reload (all apply live).
- **Release prep (2026-06-17 — public-release pass):** rewrote `README.md` for end users
  (features + screenshots in `docs/images/` + Load-unpacked install for Chrome/Brave);
  **added extension icons** (`src/icons/` 16/32/48/128 generated via System.Drawing, wired
  into the manifest `icons`/`action.default_icon`; 512 master kept in `store-assets/`, NOT
  bundled); **masked the API key field** (options page input is now `type=password` + a
  Show/Hide toggle); **trimmed permissions** — removed `sidePanel` + `scripting` (verified
  unused) and `activeTab` (redundant with `tabs` + host perms); manifest now requests only
  `storage`/`unlimitedStorage`/`tabs`/`declarativeNetRequest`. Added **`build_release.bat`**
  (sets `SYF_RELEASE=1`, which makes `build.mjs` drop sourcemaps — code stays unminified for
  review — then zips `dist/` → `releases/seths-youtube-fixer-latest.zip`, manifest at zip root).
  Added a privacy-policy draft (`PRIVACY.md`) and two reports under `docs/`:
  `CHROME_WEB_STORE_REVIEW.md` (verdict: fine to install privately; a store listing still
  needs a hosted privacy policy + the framing/internal-endpoint automation is a real
  §4.4.1/YouTube-ToS takedown risk) and `SECURITY_REVIEW.md`.
- **Security hardening (2026-06-17 — both fixed + validated in real signed-in Chrome via
  `scripts/release-shots.mjs`):**
  1. **iframe header-strip rule is now DYNAMIC.** `syf_iframe` ships `enabled:false`; the SW
     enables it **only while a `comments/search.html` window is open** and disables it on close
     (`setIframeRuleset`/`syncIframeRuleset`, keyed to a search tab existing; self-heals on SW
     wake). Enabling is done directly in the `SYF_OPEN_COMMENT_SEARCH` handler (relying on the
     tab-presence sync to ENABLE races the just-created tab's URL — it only DISABLES). Verified:
     rulesets `[]`→`["syf_iframe"]`→`[]` across open/close, bottom pane still frames the real page.
  2. **Authenticated feedback submission moved OUT of the MAIN-world bridge into the isolated
     world** (`youtube.ts`): it reads `SAPISID` from `document.cookie` and gets the page's public
     innertube config via a one-way `YT_CONFIG` message (bridge `postConfig`, polled with
     `REQUEST_CONFIG`). The bridge's page-reachable `REPLAY` handler + `submitFeedback` are gone
     (confirmed absent from the prod bundle). Closes the forgeable-`REPLAY` write primitive.
     Verified net-neutral apply→undo via the button UI. (The old `__syfSubmitFeedback` MAIN hook
     was removed; `__syfDebug` read-only peek stays, still `__SYF_DEV__`-gated. Dev scripts
     test-undo/test-native/validate-replay/recon-yt-history3 used that hook and are now superseded
     by the UI-driven path.)
  `typecheck` + `build` green after all changes.
- **Comment-search settings (2026-06-17):** the per-scan comment cap is now a **user setting**
  (`settings.commentScanCap`, default **50,000**, range **1,000–200,000** in the options page) instead
  of a hardcoded 10,000 — comments aren't persisted, so it only bounds one scan's time/quota; search.ts
  reads it on window open. Added a **local API-quota estimate** (the Data API can't report real
  remaining quota to a key): the SW counts each `commentThreads`/`comments` call (1 unit) into
  `syf.quota` `{ptDate, used}`, **resets at midnight Pacific** (`Intl` `America/Los_Angeles` date),
  throttled writes, exposed via `SYF_GET_QUOTA` / `SYF_RESET_QUOTA`. Options page shows a gauge + a
  configurable daily limit (`settings.apiDailyQuota`, default 10,000) + a Google Cloud quota link +
  "Reset counter"; the search window shows a compact readout (refreshed after each search). It's an
  estimate (doesn't see other consumers of the same key). `QUOTA_KEY` is in `ALL_STORAGE_KEYS` (cleared
  by Reset). Validated end-to-end: counter == actual API calls, both UIs render, limit + reset work.
  The **"Replies too" checkbox now persists** (`settings.commentSearchReplies`): restored when the
  search window opens, saved (via `SYF_PATCH_SETTINGS`) whenever toggled.
- **Internationalization audit (2026-06-17 — ja/fr/de/es/ko, LIVE-validated in real Chrome via
  `scripts/recon-i18n.mjs`):** the icon-based feedback capture ("Less like this"/"Don't recommend
  channel") and the Data-API comment search are locale-safe (icon enums / structured JSON, not UI
  text). Two features parsed English-only UI strings and were fixed to be locale-tolerant:
  - **Wipe history** — anchors on the delete `data-token` (not the localized "Delete activity item"
    aria-label, which matched **zero** items in every non-English locale), and parses the timestamp
    across 12-hour (en "3:32 PM"), 24-hour (fr/de/es/ja "15:32") and Korean ("오후 3:32") formats.
    The live run caught two more bugs the unit tests missed: (1) the video DURATION badge (also
    "\d+:\d+", e.g. "4:21") was shadowing the real timestamp — fixed by **skipping text inside the
    thumbnail `<a>`**; (2) an **off-by-one** — the delete button precedes the item's own timestamp in
    document order, so "last time before the button" grabbed the PREVIOUS item's time — fixed by
    reading each item's own inline time from its container (`ownTime`), falling back to the
    document-order time only for shared group headers. Live: 96 items + **96/96** timestamps parsed,
    each correctly attributed, in ALL of en/ja/fr/de/es/ko.
  - **Pause/Resume history** — English label match first (unchanged); other locales find the control
    by its **icon** (`PAUSE_*`/`PLAY_*`, language-independent) via `findHistoryToggleByIcon`. This
    deliberately **ignores the page's other feedbackTokens** — the DELETE-icon "Clear all watch
    history" and the ~per-video null-icon "Remove from watch history" — so it can NEVER submit the
    wrong (destructive) token; if no pause/play control exists it shows the honest backoff. An honest
    "toggled" toast is shown when the new on/off state can't be read. Live: the icon-based token
    **matches the proven English-label token** in all six locales (the /feed/history data structure
    is language-independent; only label TEXT differs). Caveat: the resume-state PLAY icon wasn't
    exercised live (history was active) — low-risk assumption, falls back to backoff if wrong.
- **Security & known residuals** (from the 2026-06-16 adversarial review; fixes landed for storage
  races, the debug globals, CSP, sender check, and transient-vs-permanent history backoff). Still
  open, low-risk for personal single-account English use — revisit before any wider distribution:
  - The MAIN-world bridge still does the authenticated `/youtubei/v1/feedback` POST and accepts a
    `to-page` `REPLAY` `postMessage` whose guard fields are page-forgeable. A script already running
    in the youtube.com MAIN world could trigger feedback writes (bounded to the feedback actions /
    history pause — not account takeover). Proper fix: nonce-gate the channel, or move submission to the isolated world
    (read SAPISID from `document.cookie` + `ytcfg` from the inline script).
  - History button label is driven by cached `lastHistoryPaused` (default = assume ON). The *action
    and toast are always correct* (the toggle reads live state from /feed/history first), but on a
    fresh install / after toggling via YouTube's own UI the pre-click label can be stale until the
    first toggle. A live state read on bar build would fix it but means opening /feed/history.
  - History pause/resume: English labels (`pause/turn on watch history`) are the primary match;
    non-English locales identify the control by its **icon** (`PAUSE_*`/`PLAY_*`, via
    `findHistoryToggleByIcon`) — which by construction ignores the page's DELETE-icon "clear all
    history" token and the null-icon per-item "remove" tokens, so it can't submit a destructive wrong
    token. Live-validated (icon token == English-label token in en/ja/fr/de/es/ko); the resume-state
    PLAY icon wasn't exercised (history was active). If no pause/play control is found → backoff.
  - Settings dialog frames `options.html` from youtube.com (needed for the feature); a malicious
    youtube.com page could clickjack the one-click Undo/Redo (Reset is behind a native confirm). The
    CSP blocks non-youtube origins.
  - `relayReplay` targets the first open youtube.com tab — a multi-account user could submit a token
    against the wrong account.
  - **(Feature 3) declarativeNetRequest strips `X-Frame-Options`/CSP** on framed
    `https://www.youtube.com/watch` sub_frames so the comment-search window can embed the real page.
    Scoped to watch pages (not `/embed/`), but it's global while installed: any site could now frame a
    YouTube *watch* page (clickjacking the user's logged-in session there). Tighter options for later:
    make the rule **dynamic** (enable only while a search window is open), or nonce/initiator-gate it.
    The framed page runs the user's real authenticated session — fine for this single-user tool.
- **Feature 2 — Wipe history (scan + UI DONE; real RPC delete VALIDATED 2026-06-17):**
  - `src/content/myactivity.ts` runs on myactivity.google.com: it anchors each item on its delete
    **token** (`data-token`/`data-date` on the item's `<c-wiz>` — **not** the localized "Delete
    activity item" aria-label) and pairs it with its own inline timestamp (`ownTime`; falls back to a
    shared group-header time), filters to a window. Timestamps parse across locales — English 12-hour
    AM/PM, 24-hour (fr/de/es/ja), and Korean 오전/오후 (`timeTextOf`/`parseTimeOfDay`); time-text
    inside the thumbnail `<a>` is skipped so the video DURATION badge (also "\d+:\d+") can't shadow
    the real timestamp. (Live-validated en/ja/fr/de/es/ko — see the i18n audit above.)
    SW (`handleWipe`) opens a fresh background My Activity tab, relays `SYF_MA_SCAN`/
    `SYF_MA_DELETE`, then closes the tab. Watch-page dialog: presets (15/30/60/120 + custom) →
    **scan → review the exact item list + window times → red Delete** (gated). Scan verified
    (`test-wipe-scan`, `test-wipe-ui`). **The real RPC delete is now validated end-to-end** on a
    Japanese (`?hl=ja`) page via `test-wipe-delete-ja.mjs`: a single-item ±30s window (hard-gated to
    exactly one item), `deleted=1`, and the item was gone from its window after reload (total 67→66).
    So token-based detection + localized timestamp parsing + the `TmdDAd` RPC all work together.
  - Caveat: timestamps are minute-precision, assumed "today" (yesterday if the time is in the
    future). Deletion re-scans after each click (DOM mutates).
  - Adapter A (UI click) is dead: the confirm "Delete" is a Material Web button (`VfPpkd-LgbsSe`)
    requiring a TRUSTED event, which content scripts can't dispatch (verified: `.click()` and full
    pointer sequences leave the count unchanged).
  - **Adapter B — RPC delete (IMPLEMENTED, chosen by Seth; live-delete VERIFIED 2026-06-17):**
    `myactivity.ts` deletes via `POST /_/FootprintsMyactivityUi/data/batchexecute?rpcids=TmdDAd`
    with `f.req=[[["TmdDAd","[[null,[\"youtube\"]],[\"<token>\"]]",null,"generic"]]]&at=<at>`.
    Per-item `<token>` = the `data-token` attr on the item's `<c-wiz>` ancestor (also `data-date`);
    `at`/`f.sid`/`bl` parsed from the inline `WIZ_global_data` script (`SNlM0e`/`FdrFJe`/`cfb2h`).
    Same-origin authed fetch — no trusted-event problem. Captured from a real delete via
    `scripts/recon-ma-rpc(2).mjs`.
  - **Live validation DONE (2026-06-17):** `test-wipe-delete-ja.mjs` deleted one real item on a
    `?hl=ja` page through the shipped content script — `deleted=1`, gone from its ±30s window after
    reload, total 67→66. (Earlier the RPC path was unconfirmed only due to My Activity propagation
    lag; it's now independently confirmed.) The review-before-delete UI still makes real use safe.
- **Feature 3 — Find in comments (DONE; verified end-to-end with a real key, 2026-06-17):**
  - Bar **Find in comments** opens a **separate normal window** (`chrome.windows.create`
    `type:'normal'`, ~940×820 — a titled, modestly-sized window, not a big chrome-less popup) of
    `comments/search.html?v=…&title=…`, via `SYF_OPEN_COMMENT_SEARCH` — NOT an in-page modal — so the
    user can keep watching/reading in the original tab while the (slow) scan runs. Reworked from the
    first cut (in-page `#syf-cs` modal) at Seth's request, 2026-06-17.
  - **Two resizable panes** (`comments/search.ts` + `.html`, styled to **YouTube's own light/dark
    scheme** via CSS vars + `prefers-color-scheme`, not the dark `.syf-*` look): a header (video
    thumb + title + search controls), then a **draggable horizontal divider** (CSS grid
    `grid-template-rows`, drag updates it; iframe `pointer-events:none` while dragging). **Top pane** =
    scrollable list of matching comments (avatar, author, age, 👍, reply count / "reply to @x" badge,
    highlighted text, ↗ open-this-comment). **Bottom pane** = the **REAL YouTube watch page in an
    `<iframe name="syf-embed">`**; clicking a match sets the iframe to `watch?v=…&lc=<id>` so the user
    Likes/Replies **natively on the real, signed-in page** ("that is real in the bottom pane").
  - **Click-outs** (`openExternal`, reuses one auxiliary window so repeats don't pile up): the header
    **thumbnail** → opens the video (`watch?v=…`) in a new window (handy if the original tab was lost);
    a comment's **avatar or author name** → opens that channel (`/channel/<id>`) in a new window. The
    ↗ on a row pops that comment out into the same auxiliary window.
  - **Framing YouTube (the linchpin):** YouTube blocks being framed (`X-Frame-Options` / CSP
    `frame-ancestors`). A **`declarativeNetRequest`** static ruleset (`rules/iframe-rules.json`,
    permission `declarativeNetRequest`) **removes `x-frame-options` + `content-security-policy`** on
    **`sub_frame` loads of `https://www.youtube.com/watch`** (scoped to framed watch pages — `/embed/`
    on other sites is untouched). Proven: the framed page renders fully + **stays signed in** (3p
    cookies OK in this profile). No JS framebust observed.
  - **`content/embed.ts`** (content script, `all_frames:true`, only acts when `window.name ===
    'syf-embed'`): **mutes + briefly pauses** the framed video so it doesn't fight the main window,
    and **drives the scroll** to the linked comment — YouTube's `&lc=` auto-scroll never fires in an
    iframe because comments lazy-load on scroll and nothing scrolls, so embed.ts scrolls `#comments`
    into view to trigger the load, then centers the highlighted/linked comment (YouTube shows it under
    a "Highlighted comment" header). Self-terminates once revealed so it never fights user scrolling.
  - **Search pipeline:** the **SW** makes the `googleapis.com` calls (`commentThreads.list`, plus
    `comments.list` when "Replies too" is on) with `settings.apiKey` (`SYF_COMMENTS_PAGE` /
    `SYF_COMMENT_REPLIES`) — key stays out of pages, dodges CORS. The search window drives pagination +
    client-side substring filtering, **streaming** matches in with live progress (scanned · matches ·
    API calls), **Stop**, and **Load more** (auto-pauses at a **user-configurable** cap
    `settings.commentScanCap`, default **50,000**, range **1,000–200,000** in the options page —
    comments aren't persisted, so it only bounds one scan's time/quota). 1 quota unit
    / 100-thread page; call count shown. `textFormat=plainText` + full HTML-escaping (no XSS). Default
    scans top-level + ≤5 free preview replies; "Replies too" deep-fetches all (more quota);
    unscanned-reply threads are counted + noted.
  - **In-window comment cache (quota saver, 2026-06-17):** fetched threads are cached in memory
    (`store`) while the window is open, so **re-searching a different word re-filters the cache with 0
    new API calls** (status shows "reused cached comments · 0 new API calls"). The cache is reused for
    `FRESH_MS` = **5 min** and only when **order + "Replies too" match**; after that, or on a param
    change, the next search re-fetches. A partial (Stopped/capped) cache is still reused and extended
    via **Load more**. Closing the window drops the cache (a reopen re-fetches). Verified by
    `scripts/test-comment-cache.mjs`.
  - **Why deep-link/embed instead of API writes** (Seth's call): the Data API has **no** like-a-comment
    endpoint and needs **OAuth** to reply; the embedded real page sidesteps both and uses the key only
    for search. **Bar button color:** "Find in comments" is a normal **ready** button once a key is
    set; it's grayed (`data-state='disabled'`) **only** when no key exists (clicking the gray one opens
    settings). `updateFindCommentsButton()` keeps it live on settings change.
  - Verified via `scripts/test-comment-search.mjs` (button state, window opens, real search, divider
    drag, bottom-pane frames + signed-in + scrolled-to-comment; screenshots in `test-results/`).
- **Open / next options:** validate the real delete (small window); more Feature 1 coverage
  (lockupViewModel), Hate end-to-end, aged replay. Possible Feature-3 extras: reuse one search window
  instead of opening a new one each click, paste a URL to search another video, whole-word/regex
  match, remember the divider position.

Dev/test scripts in `scripts/`: recon-feedback, recon-undo, recon-myactivity(2), measure-feedback,
validate-replay, test-click, test-undo, test-toggle-log, test-native, test-toast, test-wipe-scan,
test-wipe-ui, test-comment-search, test-comment-cache, debug-ma, diag, **release-shots** (release
validation: regenerates the README comment-search screenshots + checks both 2026-06-17 security
fixes — dynamic iframe rule via DNR state, and isolated-world feedback apply/undo), **recon-i18n**
(READ-ONLY i18n validation: renders /feed/history + My Activity in ja/fr/de/es/ko via the
non-persistent `?hl=` override and runs our actual parsers against the live localized DOM/data;
`recon-ma-dom`/`recon-history-data` are the one-off DOM/data dumps used to design those parsers),
**test-wipe-delete-ja** (user-approved REAL single-item delete on a `?hl=ja` My Activity page —
hard-gated to one item — that validated the `TmdDAd` RPC end-to-end), **verify-log-channel**
(READ-ONLY: opens the options page and asserts each action-log row renders the channel name with
correct `watch?v=`/`/channel/UC…` links — does not mutate the stored log).

## Layout

- `src/manifest.json` — MV3 manifest.
- `src/background/service-worker.ts` — background SW (message router, storage).
- `src/content/youtube.ts` — isolated-world content script: SPA-nav detection, bar injection.
- `src/content/page-bridge.ts` — MAIN-world script: reads ytInitialData/ytcfg, session feedback POSTs.
- `src/content/embed.ts` — isolated-world, `all_frames`: tames the bottom-pane watch iframe (mute/pause
  the video, scroll to the linked comment); only acts when `window.name === 'syf-embed'`.
- `src/content/styles.css` — bar + in-page modal styles (the comment search has its own page styles).
- `src/comments/` — the **Find in comments** window (`search.html` + `search.ts`): two resizable panes,
  YouTube-themed; top = API search results, bottom = the real watch page framed at the clicked comment.
- `src/rules/iframe-rules.json` — `declarativeNetRequest` ruleset: strips `X-Frame-Options`/CSP on
  framed `youtube.com/watch` loads so the bottom pane can embed the real page.
- `src/options/`, `src/popup/` — options page (API key, hide-shorts, TTL, **action log**, reset;
  also opened in-page as the **ℹ Info** dialog) and toolbar popup.
- `src/wipe/` — standalone Wipe-history page, opened in a new tab via `wipe.html?minutes=N`.
  (The old standalone `src/log/` page was removed — the action log now lives in the options page.)
- `src/common/messages.ts` — shared messages/types/settings.
- `src/icons/` — extension icons (16/32/48/128 PNG), referenced by the manifest; copied to
  `dist/icons/` by the build. The 512px master lives in `store-assets/` (listing art, not shipped).
- `scripts/` — esbuild build + CDP harness (`chrome-lib`, `setup`, `drive`, `reload`, `diag`).
  `build.mjs` drops sourcemaps when `SYF_RELEASE=1`.
- `build_release.bat` — production build (`SYF_RELEASE=1`) → zips `dist/` to `releases/`.
- `docs/` — `images/` (README screenshots), `CHROME_WEB_STORE_REVIEW.md`, `SECURITY_REVIEW.md`.
- `PRIVACY.md` — privacy-policy draft (host at a URL before any store listing).
- `test/` — Playwright (`fixtures.ts` attaches over CDP; `smoke.spec.ts`).

## Commands

- `npm run build` / `npm run watch` — bundle `src/` → `dist/`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run setup` — ONE-TIME: open dev profile to Load unpacked + sign in (see below).
- `npm run reload` — rebuild + hot-reload the live extension.
- `npm run drive` — rebuild + reload + smoke (injects bar, screenshots `test-results/`).
- `npm test` — rebuild + reload + full Playwright suite.
- `build_release.bat` — production build + zip to `releases/` (Windows; double-click or run).

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
