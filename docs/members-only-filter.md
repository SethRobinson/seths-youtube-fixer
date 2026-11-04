# Members-only video filter

The optional **Settings → Feed → Hide members-only videos** checkbox controls
`settings.hideMembersOnly` (default `false`). It auto-saves and applies live to
open YouTube pages. It hides marked video cards on Home, Search, Subscriptions,
channel pages, and the Watch sidebar. Manual channel exceptions keep selected
channels visible, including channels the viewer belongs to. It does not change
memberships or submit recommendation feedback. Opening a video directly still works.

## Channel exceptions

Under the toggle, **Always show members-only videos from these channels** accepts
an `@handle`, a YouTube channel URL, or a canonical `UC…` channel ID. Click **Add
channel** (or press Enter) to save it; **Remove** immediately filters that channel
again. Exceptions can be edited while the filter is off without enabling it.
They affect only this filter; Shorts and playlist filters remain independent.

`src/common/channel-exceptions.ts` validates the input before requesting a public
YouTube channel page, without credentials or API quota. It reads
`metadata.channelMetadataRenderer.externalId` and `title`, and stores
`settings.membersOnlyChannelExceptions` as `{channelId, name}[]` (default `[]`).
The stable ID survives handle changes. Invalid, offsite, video, and playlist URLs
are rejected; unavailable channels and network errors are shown beside the form.
Names are rendered as text, not HTML. No membership purchase or detection occurs.

The SW's `SYF_ADD_MEMBER_EXCEPTION` / `SYF_REMOVE_MEMBER_EXCEPTION` handlers
serialize list edits with the other settings writes, preventing lost updates
between settings windows and deduplicating handles/URLs that resolve to the same
channel. `storage.onChanged` updates the list and open YouTube pages live. These
are manual browser preferences, shared across YouTube account switches like the
other feed settings. Reset data clears them with the rest of `syf.settings`.

## Detection and display

`src/common/members-only.ts` reads these explicit membership markers:

- Modern `lockupViewModel` metadata badges: `badgeViewModel.badgeStyle ===
  'BADGE_MEMBERS_ONLY'`.
- Classic video renderers: `metadataBadgeRenderer.style ===
  'BADGE_STYLE_TYPE_MEMBERS_ONLY'`, or `sponsorsOnlyBadgeRenderer`.

Labels and titles are not classification inputs. In YouTube's November 2026
client, `BADGE_MEMBERS_ONLY` and `BADGE_COMMERCE` share the same visual commerce
style; hiding every green/commerce badge would hide unrelated content.

`page-bridge.ts` collects membership state during its existing JSON traversal,
including live Polymer data after SPA navigation and intercepted browse/next/search
responses for continuations. It posts only changed `MEMBER_VIDEOS` entries. The
existing config handshake also replays the current set, handling an initial
capture before the isolated content script is listening. A later public badge
state removes an earlier members-only entry. Maps store uploader IDs alongside
membership state and are capped at 5,000 videos in both worlds, without persistence.

Uploader IDs come from the card's byline/avatar metadata, never arbitrary IDs in
its menu. Channel upload grids omit uploader metadata entirely: for a selected
Videos/Streams/Membership tab, the bridge scopes the channel metadata ID to that
tab's contents and remembers its grid target ID for matching continuations (128
targets maximum). Unrelated continuation targets and featured channel pages do
not inherit that owner. Explicit card ownership overrides this fallback. Later
owner hydration updates the map; sparse data cannot erase a known uploader.

`youtube.ts` creates a stylesheet while the setting is on. It uses validated
11-character video IDs to select whole video cards by their watch links; URL
query boundaries prevent prefix matches. CSS `:has()` collapses the outer
`ytd-rich-item-renderer` too, avoiding empty grid slots. The selectors keep working
for lazy insertion and recycled URLs without another observer, timer, or DOM scan.
The same generated rule includes a fallback for legacy membership badge elements.
Exempt video IDs are excluded from the entire rule, including this fallback,
so it cannot override exceptions. No `display` override is applied to exempt
cards, preserving the effect of other feed filters. Turning the setting off
removes the generated stylesheet and reveals the cards.

Modern cards must expose the badge in YouTube's page data before filtering can
identify them. They may briefly appear during hydration. Unsupported future card
or badge shapes are left visible.

## Verification

- `npm run typecheck` and `npm run build`.
- `node scripts/test-members-only-unit.mjs`: offline badge recognition, translated
  labels, public/commerce negatives, public-state updates, invalid IDs, and CSS URL
  boundaries, uploader scoping, channel input/resolution and failure cases,
  exception CSS, plus the bundled bridge's startup replay, owner hydration,
  upload-grid scope, and continuation matching. **14 tests**.
- `node scripts/test-members-only.mjs --data-only`: read-only public HTTP repro on
  Switch and Click's Videos tab, using the production detector on real page data.
- `node scripts/test-members-only.mjs`: dedicated Chrome/CDP profile, real marked
  cards, options auto-save/persistence, filtering after reload, public-card
  preservation, and reversible DOM fixtures for Home/sidebar/Search/legacy cards,
  lazy insertion, and recycled URLs. Also tests adding/removing an exception against
  real marked cards, preserving another uploader's filtering, invalid inputs,
  duplicate handles/URLs, concurrent additions, cross-window updates, and both
  settings/YouTube reloads. Checks that exceptions do not override Hide Shorts.
  Restores the original settings object in `finally`;
  it opens no watch pages and sends no account feedback.

Browser harness use requires Seth's explicit approval under `AGENTS.md`.

Validated on 2026-11-04 with the signed-in dedicated Chrome test profile: real
members-only cards hidden and restored, real public cards preserved, and all
layout/reload/auto-save checks passed. The channel membership-tab run also hid
six real marked cards. Public HTTP reproduction found 12 marked videos there;
personalized Home recommendations were not required to contain a marked card.
The exception tests also passed in the signed-in profile, and the settings layout
was checked at 700px and 420px widths with no horizontal overflow.

## Automatic membership detection: investigation (2026-11-04)

Manual exceptions are implemented; automatic membership discovery is not. Inspection
of real non-member card data did not reveal a viewer-membership or entitlement flag;
`BADGE_MEMBERS_ONLY` identifies the video's restriction. A joined-account sample
has not been tested, so do not assume member and non-member card payloads match.

YouTube documents a channel-header distinction: non-members see **Join**, while
members see **See perks**. Active memberships can also be managed on
`youtube.com/paid_memberships`. These could support account-specific discovery
and caching, but would introduce another scraper and need positive-member tests,
expiry/cancellation handling, and account-switch isolation. Absence of a Join
button alone must never be treated as proof of membership.

The public Data API's `members.list` endpoint is creator-authorized and lists a
creator's members; it is not a viewer API for channels the viewer has joined.
The manual exception list deliberately avoids this dependency.

References: [YouTube membership benefits](https://support.google.com/youtube/answer/14917424?hl=en),
[managing memberships](https://support.google.com/youtube/answer/6304294),
[Data API access restrictions](https://developers.google.com/youtube/data/reference/rest/v3/members/list).
