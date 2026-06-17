# Security &amp; performance review

*Review of **Seth's YouTube Fixer** source as of this release-prep pass. Severity:
🔴 red (fix before wider distribution) · 🟠 orange (real, bounded — worth fixing) ·
🟡 yellow (low risk / hygiene) · 🟢 green (done well).*

## Summary

The code is, overall, **carefully written** — consistent HTML-escaping, serialized
storage writes, throttled/coalesced caching, an origin-checked message router, no remote
code, and dev-only account-write hooks compiled out of release builds. There are **no
memory-safety or XSS holes** that I found. The notable items are all about the inherent
power of what the extension does (authenticated writes to YouTube using your session, and
removing a security header to frame YouTube), not sloppy implementation.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | 🔴→🟢 | DNR strips `X-Frame-Options`/CSP on **all** `youtube.com/watch` sub-frames, globally, while installed → any site can frame your signed-in YouTube | ✅ **Fixed** — rule now dynamic (on only while a search window is open), validated |
| 2 | 🟠→🟢 | MAIN-world bridge does an authenticated write and accepts a **page-forgeable** `REPLAY` postMessage | ✅ **Fixed** — write moved to the isolated world; no page-reachable primitive, validated |
| 3 | 🟠→🟢 | Captured feedback tokens are broadcast to the page via `postMessage` (readable by any youtube.com script) | ✅ **Largely moot** — the write primitive it fed is gone; tokens were already page-readable from YouTube's own data |
| 4 | 🟡 | Options page is `web_accessible` to youtube.com + framable → theoretical clickjack of one-click Undo/Redo | Open (low risk; CSP-limited) |
| 5 | 🟡 | Irreversible My Activity delete; RPC path not independently validated; minute-precision time heuristic | Mitigated by review-before-delete |
| 6 | 🟡 | API key in plaintext `storage.local` | Now masked in UI; acceptable |
| 7 | 🟡 | `relayReplay` targets the *first* youtube.com tab (wrong account for multi-account users) | Open (minor) |
| 8 | 🟢 | Over-broad permissions (`sidePanel`/`scripting`/`activeTab`) | ✅ removed this pass |
| 9 | 🟠(perf) | `window.fetch` is monkey-patched; large innertube responses are cloned + deep-walked | Acceptable; can bound |

> **Update:** the two headline issues (#1, #2) were fixed and validated in a real signed-in
> Chrome this pass — see the ✅ notes inline below.

---

## 🟢 1. declarativeNetRequest removes a security header globally — ✅ FIXED

> **Fixed this pass:** the `syf_iframe` ruleset now ships **disabled** (`manifest.json`), and the
> service worker **enables it only while a Find-in-comments window is open** and disables it again
> when that window closes (`setIframeRuleset` / `syncIframeRuleset` in `service-worker.ts`, keyed to
> the presence of a `comments/search.html` tab; self-heals on SW wake). Validated in a real signed-in
> Chrome: rulesets `[]` before open → `["syf_iframe"]` while open → `[]` after close, and the bottom
> pane still framed the real signed-in page. Exposure dropped from "always installed" to "while you're
> actively searching comments." The original analysis follows for context.

`src/rules/iframe-rules.json` removes `x-frame-options`, `frame-options`,
`content-security-policy`, and `content-security-policy-report-only` on **every**
`sub_frame` load of `https://www.youtube.com/watch`, for as long as the extension is
installed — not just while a comment-search window is open.

**Why it matters:** `X-Frame-Options`/`frame-ancestors` are exactly what stops
*clickjacking*. With them stripped, **any website you visit can silently embed a YouTube
watch page in a hidden/overlaid iframe** — and because YouTube loads with your logged-in
session, a malicious page could try to trick you into clicking things on your real account
(subscribe, like, etc.) through an invisible overlay. The scope is good (only `/watch`,
only sub-frames, so `/embed/` elsewhere is untouched), but the **time** scope is "always,"
and the **CSP** removal is the whole header rather than just `frame-ancestors`.

**Recommendations (in order of value):**
1. **Make the rule dynamic** — keep it in the manifest as a *disabled* static ruleset (or
   session rules) and enable it only while a comment-search window is open, then disable
   it on window close (`chrome.declarativeNetRequest.updateEnabledRulesets` /
   `updateSessionRules`). This collapses the exposure window from "always" to "the few
   minutes you're actively searching comments." Biggest risk reduction for the least code.
2. **Narrow the CSP edit** — instead of removing the entire `Content-Security-Policy`,
   remove only the `frame-ancestors` directive (a regex `modifyHeaders` is awkward in DNR,
   so this may mean keeping the whole-header removal but pairing it with #1).
3. This is also the #1 **store-policy** risk — see
   [`CHROME_WEB_STORE_REVIEW.md`](CHROME_WEB_STORE_REVIEW.md) §A/§E.

## 🟢 2. Forgeable `REPLAY` message → authenticated write primitive in the page world — ✅ FIXED

> **Fixed this pass:** the authenticated `POST /youtubei/v1/feedback` (and the SAPISIDHASH signing)
> were **removed from the MAIN-world bridge entirely** and now run in the **isolated** content script
> (`youtube.ts`), which reads `SAPISID` directly from `document.cookie` and gets the page's *public*
> innertube config (api key + client context) via a one-way `YT_CONFIG` message. The bridge no longer
> has a `REPLAY` handler or any submit function — verified absent from the production bundle (no
> `SAPISIDHASH`, no feedback `POST`, no `REPLAY`). A page-world script can no longer forge a message to
> write feedback. Validated end-to-end (apply "Not interested" → undo, net-zero) via the button UI in a
> real signed-in Chrome. The original analysis follows for context.

`src/content/page-bridge.ts` runs in the **MAIN world** and exposes `submitFeedback()`
(`page-bridge.ts:362`), which does the real authenticated `POST /youtubei/v1/feedback`
(builds `SAPISIDHASH` from the `SAPISID` cookie). It runs that whenever it receives a
`postMessage` with `{__syf:true, dir:'to-page', type:'REPLAY', token}`
(`page-bridge.ts:403-416`). Those guard fields are **page-forgeable**: any script already
running in youtube.com's MAIN world can post the same shape.

**Impact is bounded** — an attacker-controlled in-page script could submit "Not
interested" / "Don't recommend channel" / pause-history *using your session*, but only
with a **valid feedback token** (which it would have to scrape from the page itself), and
it **cannot** escalate to account takeover. So: unwanted feedback writes, not credential
theft. (Already documented as a known residual in `AGENTS.md`.)

**Recommendations:**
- **Best:** move the authenticated POST out of the MAIN world. The **isolated** content
  script can read `document.cookie` (so it can build `SAPISIDHASH` itself) and can scrape
  `ytcfg`/`INNERTUBE_CONTEXT` from the page's inline script text — eliminating the
  page-callable write primitive entirely.
- **Cheaper:** nonce-gate the channel. The isolated world generates a random nonce at
  injection and requires it on every `to-page` message; a page script can't guess it.

## 🟠 3. Feedback tokens are broadcast to the page

`post()` in `page-bridge.ts:14` sends captures (which include `feedbackToken`s) via
`window.postMessage(msg, location.origin)`. Both the isolated content script **and** any
MAIN-world script on the page receive them. Combined with #2, a hostile in-page script
could both **read** tokens and **replay** them. Same fix as #2 (a nonce'd or isolated
channel). Low absolute severity (tokens only authorize feedback actions).

## 🟡 4. Options page is web-accessible to youtube.com and framable

`manifest.json` exposes `options/options.html`+`.js` as `web_accessible_resources` to
youtube.com, and the CSP `frame-ancestors 'self' https://www.youtube.com` lets youtube.com
frame extension pages — both **needed** for the in-page "ℹ Info" dialog
(`youtube.ts:openSettingsDialog`). The residual: a malicious youtube.com page could frame
`options.html` and try to **clickjack** the one-click Undo/Redo buttons. "Reset data" is
behind a native `confirm()`, so the dangerous action is protected; and the CSP blocks
*non*-youtube origins from framing it. **Low risk; acceptable.** If you want to harden it,
add a require-confirmation step (or frame-busting) to Undo/Redo, or gate the iframe with a
nonce passed from the content script.

## 🟡 5. Irreversible history deletion, not fully validated

`src/content/myactivity.ts` deletes via My Activity's internal `batchexecute` RPC. Per
`AGENTS.md`, the **RPC delete path has not been independently confirmed end-to-end**, and
timestamps are **minute-precision and assumed to be "today"** (yesterday if the time is in
the future). The **review-before-delete** UI (`src/wipe/wipe.ts`) is the right mitigation —
the user sees the exact item list + window before the red Delete, and the copy says
"can't be undone." For public users this is the main *data-loss* risk (not a security
hole). **Recommendations:** keep the review gate; validate the RPC on a tiny window before
trusting it broadly; consider a first-run "this permanently deletes from your Google
account" confirmation.

## 🟡 6. API key storage

The key lives in `chrome.storage.local` in plaintext (this is normal for extensions —
`storage.local` isn't encrypted, and there's no better local store for it). It's sent only
to `googleapis.com` over HTTPS, never to youtube.com's page world (the service worker makes
the call — `service-worker.ts:fetchCommentsPage`). The UI field is now a **masked password
input with a Show toggle** (this pass), which addresses shoulder-surfing. Anyone with local
machine access / DevTools can still read it — acceptable for a low-value, per-user,
read-only quota key.

## 🟡 7. `relayReplay` picks the first YouTube tab

`service-worker.ts:relayReplay` (≈line 247) sends the Undo/Redo replay to
`tabs.find(t => t.id)` among youtube.com tabs. For a user signed into **multiple Google
accounts** across tabs, the action could be submitted against the wrong account. Minor;
consider preferring the active tab or the account that logged the action.

## 🟢 8. Permissions cleanup (done this pass)

Removed `sidePanel` (declared, never used), `scripting` (no dynamic injection — content
scripts are static), and `activeTab` (redundant with `tabs` + host permissions). The
manifest now requests only `storage`, `unlimitedStorage`, `tabs`, `declarativeNetRequest`.
`m.youtube.com` host permission is currently unused and could also be dropped.

---

## Performance

| Area | Assessment |
|---|---|
| 🟠 `window.fetch` monkey-patch (`page-bridge.ts:307`) | Every YouTube fetch passes through a wrapper (cheap regex). On `/youtubei/v1/{browse,next,search,guide}` responses it **clones + JSON-parses the full body** and deep-walks it (`extractTuples`, depth ≤45, WeakSet-guarded). On large infinite-scroll continuations this is real CPU/GC. Mitigated by per-tick dedup (only new/changed tuples are sent) and being limited to those endpoints. **Acceptable; could bound** walk size/depth or skip oversized bodies. |
| 🟢 MutationObserver (`youtube.ts:588`) | Observes `documentElement` subtree `childList` (fires a lot on YouTube) **but is coalesced** via a `requestAnimationFrame` + `scheduled` flag, so `ensureBar()` runs at most once per frame. Plus a 3 s interval and a 6× 700 ms post-navigation tick — all light. Good. |
| 🟢 Cache writes (`service-worker.ts`) | Writes are **throttled (≤ once / 2 s), coalesced, and skip no-op re-sightings**, so a ~160-video scroll burst is a single write. In-memory copies of cache/log/settings mean lookups never re-parse storage. LRU cap + 50 MB byte backstop keep load/save fast. Excellent. |
| 🟢 Comment search | Streams results with a **configurable** scan cap (default 50,000, max 200,000) and an in-memory 5-minute reuse cache (re-searching a new word costs 0 API calls). Comments are never persisted, so the cap only bounds one scan's time/memory/quota. "Replies too" warns it uses more quota. Reasonable. |

## What's done well (🟢)

- **No XSS:** every place user/remote text is rendered uses the `esc()` helper
  (`options.ts`, `wipe.ts`, `comments/search.ts`) and comments are fetched as
  `textFormat=plainText`; the highlight builder escapes each slice.
- **Message router is origin-checked:** the SW rejects anything where
  `sender.id !== chrome.runtime.id` (`service-worker.ts:375`); no `externally_connectable`.
- **Dev-only account-write hooks** (`__syfSubmitFeedback`, `__syfDebug`) are compiled out
  unless `SYF_DEV=1` (`build.mjs` `define`), and `build_release.bat` never sets it.
- **No remote code, no telemetry, no third-party servers**; data stays local.
- **Storage writes are serialized** (`enqueue`) so concurrent messages can't clobber, and
  Reset cancels any pending flush so a late write can't resurrect deleted data.

## Priority recommendations

1. ✅ **Done — iframe header-stripping rule is now dynamic** (on only while a search window is
   open). Removed the always-on clickjacking surface and shrank the top store-policy risk. *(#1)*
2. ✅ **Done — authenticated feedback POST moved to the isolated world.** Removed the
   page-callable write primitive (and made the token broadcast moot). *(#2/#3)*
3. Keep the review-before-delete gate; validate the My Activity RPC on a small window
   before relying on it. *(🟡 #5)*
4. Optionally drop the unused `m.youtube.com` host permission. *(🟡 #8)*
5. Remaining lower-priority items: options-page clickjack hardening (#4), multi-account
   `relayReplay` targeting (#7), and bounding the innertube deep-walk (#9).
