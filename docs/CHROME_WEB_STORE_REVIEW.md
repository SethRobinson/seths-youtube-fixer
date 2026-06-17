# Would this be accepted into the Chrome Web Store?

*Assessment of **Seth's YouTube Fixer** against current (June 2026) Chrome Web Store
policies. Verdicts: **CLEAR** / **RISKY** / **LIKELY-REJECTION** / **HARD BLOCKER**.
Policy text is quoted from official sources with URLs.*

## TL;DR

**Short answer: it *could* get in, but not as-is, and the comment-search feature carries
a real, ongoing takedown risk even after cleanup.**

There is **no policy that names `X-Frame-Options` or CSP** and bans removing them — and
the technique is demonstrably shippable (a near-identical "iFrame Unlocker" extension is
live, last updated 2025-07-17). The real exposure isn't the header trick itself; it's a
**chain**: the CWS Developer Agreement **§4.4.1** forbids products that *"knowingly
violate a third party's terms of service,"* and a few features here plausibly breach
**YouTube's** ToS / **YouTube API** policies (framing the watch page by defeating its
anti-framing header; automating undocumented internal endpoints with your session).

Three things would have **blocked submission outright** — all three are now addressed in
this repo except the privacy policy hosting:

| Blocker | Status |
|---|---|
| No icons at all (128px is mandatory) | ✅ **Fixed** — `src/icons/` (16/32/48/128) wired into the manifest |
| `sidePanel` permission declared but never used (a documented near-certain rejection) | ✅ **Fixed** — removed (also removed unused `scripting` and redundant `activeTab`) |
| No privacy policy (mandatory because it reads auth cookies + stores an API key) | ⚠️ **Drafted** in [`PRIVACY.md`](../PRIVACY.md) — you still need to **host it at a URL** and link it in the dashboard |

**Most likely outcome if submitted today (after hosting the privacy policy + adding store
screenshots):** it lands in the **manual-review** bucket (reads cookies + modifies
response headers + several sensitive permissions), and there's a **genuine chance of
rejection or post-publish takedown** on the framing/automation features under §4.4.1.

**My recommendation:** for a personal/power-user tool, **keeping it private (load-unpacked
or self-distributed zip) avoids every one of these issues** and is the lower-friction
path. If you do want it listed, the single highest-leverage change is the
comment-search framing — see §A/§E, including the **tradeoff** that the "compliant" fix
would remove the feature's whole point.

---

## A. Stripping `X-Frame-Options` / CSP to frame YouTube — **RISKY** (the #1 concern)

**Verdict: the technique is allowed by the API and not banned by any header-specific
policy — but applying it *to youtube.com* defeats YouTube's anti-framing protection,
which chains into two CWS clauses + YouTube's ToS.**

- The DNR API explicitly supports `modifyHeaders` → `remove` on response headers; the
  header *allowlist* restriction only applies to *appending request* headers.
  (https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- **No CWS clause names security headers.** But two general clauses reach it:
  - *"Do not facilitate unauthorized access to content on websites, such as circumventing
    paywalls or login restrictions."*
    (https://developer.chrome.com/docs/webstore/program-policies/policies) — paywall/login
    is the named example; an anti-framing header is analogous but weaker (the video is
    public). *[A reviewer could stretch this; not a slam dunk.]*
  - **Developer Agreement §4.4.1** (verbatim): products must not *"knowingly violate a
    third party's terms of service"* nor *"interfere with, disrupt, … or accesses in an
    unauthorized manner the … properties or services of any third party."*
    (https://developer.chrome.com/docs/webstore/program-policies/terms) — **this is the
    strongest hook**, because YouTube's ToS bars circumventing *"security-related
    features,"* and `X-Frame-Options` is exactly that.
- **Precedent both ways:** Chrome DevRel has publicly handed out `modifyHeaders` code to
  strip `X-Frame-Options`, warning only about *clickjacking* (not policy), and advising
  you scope it to **sub-frames, specific domains, on your own extension pages**
  (https://groups.google.com/a/chromium.org/g/chromium-extensions/c/HzEO5vnyocc). A live
  extension does essentially this today.

**Our rule** (`src/rules/iframe-rules.json`) is already scoped to `sub_frame` +
`|https://www.youtube.com/watch` — good. As of this pass it's also **dynamic**: it ships
disabled and the service worker enables it only while a Find-in-comments window is open
(then turns it off), so it's no longer modifying headers for sites at large the whole time
the extension is installed. The remaining over-broad part is that it removes the **entire**
`Content-Security-Policy` header rather than just `frame-ancestors`. (Note: the dynamic
scoping helps the *security* posture and the "narrowest change" optics, but it does **not**
resolve the substantive risk here — framing the watch page against YouTube's ToS, §E.)

**Recommendation:** if you keep framing, **narrow the CSP removal to only what's needed**
(ideally only neutralize `frame-ancestors`) and disclose it in the listing. The
header-stripping alone won't auto-reject; the *framing-YouTube-against-its-ToS* angle (§E)
is the live risk.

## B. Single Purpose — **CLEAR (low–moderate risk)**

A YouTube-focused, multi-feature extension is allowed. *"'Single purpose' can refer to …
a narrow focus area or subject matter… it can offer various functions related to that
focus area."* (https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq)
The violation examples are all *unrelated* bundles ("email notifier + news aggregator").
Every feature here is a YouTube-viewing control, so it fits one purpose.

Two soft spots: (1) the **myactivity.google.com** surface can read as "a separate Google
tool" — frame it in the listing as *YouTube watch-history* cleanup; (2) the FAQ disallows
*"broad, multi-purpose toolbars"* — so **don't market it as a "toolbar/toolbox."**

**Recommendation:** one-sentence listing purpose ("Control what YouTube recommends and
manage your YouTube history"); tie the history-wipe explicitly to YouTube.

## C. Permissions / least privilege — **was a LIKELY-REJECTION, now mostly addressed**

Policy: *"Request access to the narrowest permissions necessary… Don't attempt to
'future proof'… by requesting a permission that might benefit … features that have not
yet been implemented."* (https://developer.chrome.com/docs/webstore/program-policies/permissions)

| Permission | Verdict | Note |
|---|---|---|
| ~~`sidePanel`~~ | ✅ removed | Was declared but **never used** — a documented near-certain rejection. |
| ~~`scripting`~~ | ✅ removed | No `chrome.scripting` call exists; content scripts are static. |
| ~~`activeTab`~~ | ✅ removed | Redundant with `tabs` + host permissions. |
| `tabs` | RISKY (kept, needed) | "Sensitive"; shows *"Read your browsing history"* at install. Used to open/relay background tabs. |
| `declarativeNetRequest` | RISKY (kept, needed) | Shows *"Block content on any page."* |
| host perms (youtube / m.youtube / myactivity / googleapis) | RISKY (kept) | Extend review, **but they're named hosts, not `<all_urls>` wildcards** — materially lower risk. `m.youtube.com` is currently unused and could be dropped. |
| `storage` / `unlimitedStorage` | CLEAR | Benign, no warning. |

*"Reviews may take longer for extensions that request broad host permissions or sensitive
execution permissions…"* (https://developer.chrome.com/docs/webstore/review-process)

**Recommendation:** fill a clear per-permission justification in the dashboard's
Privacy-practices tab; consider dropping the unused `m.youtube.com` host.

## D. Automating YouTube/Google with the user's session — **RISKY**

No CWS clause bans this by name, and the actions are **user-initiated** (which defeats the
"without consent" angle). But it chains into **§4.4.1** again, because the underlying
conduct breaches third-party terms:

- **YouTube ToS** bars *"access[ing] the Service using any automated means"* and
  *"circumvent[ing] … or otherwise interfer[ing] with … security-related features."*
  (https://www.youtube.com/t/terms) — the internal `youtubei/v1/feedback` replay and the
  SAPISIDHASH-from-cookie auth are non-sanctioned access.
- **YouTube API Developer Policies** bar reverse-engineering *"undocumented YouTube API
  services"* and using *"information that the user provides or that YouTube displays …
  during authentication."* (https://developers.google.com/youtube/terms/developer-policies)
- The **My Activity** delete is the *lower*-risk half (it performs an action the user is
  entitled to do), but the `batchexecute` RPC is still automated/undocumented access under
  Google's general terms.

**Recommendation:** keep every action user-initiated (it is) and say so in the listing.
Understand this does **not** cure the ToS-breach hook — it's a discretionary gray zone.

## E. YouTube Data API + framing the watch page — **API use CLEAR with conditions; framing RISKY**

- **Your own key doesn't exempt the developer.** The API ToS bind the distributed client
  and you. Two concrete obligations:
  - **Attribution is mandatory:** *"Any API Client … that displays YouTube content must
    make clear … that YouTube is the source … by displaying YouTube Brand Features."*
    → the comment-search UI should show a "YouTube" attribution.
  - **30-day storage cap:** *"API Clients may temporarily store limited amounts of
    Non-Authorized Data … but not longer than 30 calendar days."*
    (https://developers.google.com/youtube/terms/api-services-terms-of-service) — our
    comment cache is **in-memory and ~5 minutes** (`FRESH_MS`, dropped when the window
    closes), so it's comfortably within this. *(The feedback-token cache is page-scraped,
    not API data, so the 30-day API cap doesn't apply — though note its TTL is
    user-configurable up to 365 days.)*
- **Framing the watch page** is the issue: YouTube's ToS grants exactly one embed path —
  *"through the embeddable YouTube player"* — i.e. the official `youtube.com/embed/…`
  IFrame Player API. Framing the full `/watch` page by stripping its headers is outside
  that grant.

**The honest tradeoff:** the "compliant" fix everyone will suggest — *use the official
IFrame Player API* — **does not work for this feature**. The official player only plays
the video; it can't show the comment section, and the entire point of the bottom pane is
to Like/Reply on the *real comment* natively. So you can't both (a) keep "click a match →
act on the real comment inline" and (b) be clean on this clause. Your options are: keep
the feature and accept the risk (fine for private use); or, for a store listing, replace
the inline real-page pane with a **"open this comment on YouTube" deep link** (opens a new
tab to `watch?v=…&lc=…`) — slightly less slick, but no framing and no header stripping.

## F. Manifest / listing requirements — **icons FIXED; privacy policy + screenshots remain**

- **Icons — was a HARD BLOCKER, now ✅ fixed.** *"You must provide a 128x128-pixel
  extension icon."* (https://developer.chrome.com/docs/webstore/images) Added 16/32/48/128
  PNGs + manifest `icons`/`action.default_icon`.
- **Privacy policy — HARD BLOCKER, ⚠️ still open.** Mandatory because the extension reads
  *"authentication … cookies"* (sensitive) and stores an API key:
  *"Products that handle personal or sensitive user data must … Post a privacy policy …"*
  (https://developer.chrome.com/docs/webstore/program-policies/user-data-faq). A draft is
  in [`PRIVACY.md`](../PRIVACY.md) — **host it at a public URL** and add it to the listing,
  then complete the **Privacy practices** tab (disclose data types; certify the **Limited
  Use** statement verbatim).
- **Screenshots — required.** At least one 1280×800 (or 640×400) screenshot. The images in
  `docs/images/` can be the basis.

## G. Remote code / obfuscation / sourcemaps — **CLEAR**

- MV3 requires all logic in the package; **we ship no remote code** — compliant.
- *"Developers must not obfuscate code…"* but minification is fine
  (https://developer.chrome.com/docs/webstore/program-policies/code-readability). The
  build ships **readable, unminified** JS — ideal for review. `build_release.bat` also
  **drops sourcemaps** from the shipped zip (smaller, and `.map` files are allowed anyway).

## H. Likely rejection triggers, in order, and the process

1. ~~Unused `sidePanel`~~ ✅ fixed · 2. ~~Missing icons~~ ✅ fixed · 3. **Missing
hosted privacy policy** ⚠️ · 4. **Header-stripping + framing youtube.com** as a
third-party-ToS circumvention (A/E) · 5. Per-permission justifications not filled in.

*"The review process uses a combination of manual and automated systems."* … *"For most
extensions, review is completed within a few days, but it can take up to a few weeks."*
(https://developer.chrome.com/docs/webstore/review-process) Because it reads cookies + has
sensitive permissions + modifies headers, expect the **slower, manual** end. Post-publish,
minor violations usually get a 7–30 day warning window — **but circumventing an
enforcement action terminates the developer account**, so don't play games if warned.

---

### Bottom line

- **Keep it private** → zero policy exposure; this is what I'd recommend for a power-user
  tool. Install via "Load unpacked" or the `build_release.bat` zip.
- **List it on the store** → mandatory before submitting: host the privacy policy, add
  screenshots, fill permission justifications. Then decide on the comment-search pane: keep
  the framed real page (slicker, but a real §4.4.1/YouTube-ToS takedown risk) or switch to
  a deep-link-out (compliant, slightly less slick). Items already done for you: icons,
  permission cleanup, unminified build, sourcemap-free release zip.
