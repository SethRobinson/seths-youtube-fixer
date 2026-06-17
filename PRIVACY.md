# Privacy Policy — Seth's YouTube Fixer

_Last updated: 2026-06-17_

Seth's YouTube Fixer is a browser extension that adds controls to YouTube. This policy
explains exactly what it does and does not do with your data. The short version:
**everything stays on your own computer. There are no servers, no analytics, and nothing
is ever sold or shared.**

## What the extension stores (locally, in your browser only)

Using Chrome's `storage.local`, on your device:

- **Feedback actions it captures from YouTube** — video IDs, channel IDs, video titles,
  channel names, and the "Not interested" / "Don't recommend channel" action tokens that
  YouTube itself puts on recommendation cards. These power the "Less like this" /
  "Don't recommend channel" buttons and the action log.
- **An action log** — a record of feedback actions you took (so you can undo/redo them).
- **Your settings** — including your optional YouTube Data API key (used only for comment
  search), the Hide Shorts toggle, and cache limits.
- **A short-lived comment cache** — when you use "Find in comments," fetched comments are
  held **in memory only, for about 5 minutes, and discarded when you close the window.**

You can erase all of the above at any time with **Reset data for this extension** in the
settings page.

## What it never stores or transmits

- It **never** stores your Google/YouTube password, cookies, or session tokens.
- It has **no servers and no analytics**. No usage data, telemetry, or personal
  information is ever sent to the developer or any third party.
- Your data is **never sold, shared, or used for advertising.**

## Network requests it makes

The extension only ever talks to:

1. **YouTube (`youtube.com`)** — using **your own existing logged-in session**, to perform
   the same actions the site already offers you (submit "Not interested" / "Don't recommend
   channel" feedback, pause/resume watch history) and to display the real YouTube page in
   the comment-search window.
2. **Google's My Activity (`myactivity.google.com`)** — using your existing session, only
   when you use "Wipe history," to delete YouTube activity you select.
3. **Google's YouTube Data API (`googleapis.com`)** — only if you add an API key and use
   "Find in comments," to read public comments. The request includes **your** API key and
   uses **your** daily quota.

No other destinations are contacted.

## Your API key

If you choose to use comment search, your YouTube Data API key is stored locally on your
device and sent only to Google's API over HTTPS. It is hidden by default in the settings
screen. It is never synced, uploaded, or shared.

## Permissions

The extension requests only the permissions it needs to do the above (storage, access to
YouTube / My Activity / the Google API, the ability to open helper tabs, and the ability to
display the real YouTube page inside its comment-search window). It does not run on, read,
or modify any site other than YouTube and Google My Activity.

## Changes

If this policy changes, the updated version will be posted with a new "Last updated" date.

## Contact

Seth A. Robinson — <https://www.rtsoft.com>
