# Seth's YouTube Fixer

A Manifest V3 Chromium extension that adds power-user controls to YouTube:

- **Less like this** — send YouTube's real *Not interested* feedback for the current video.
- **Don't recommend channel** — send YouTube's real *Don't recommend channel* feedback.
- **Wipe history** — fast-delete recent YouTube activity via Google My Activity.
- **Find in comments** — search all public comments/replies via the YouTube Data API.

> Status: scaffold + automated test harness in place. Features are being built one
> vertical slice at a time. See `DESIGN` discussion in the project notes.

## Develop

```bash
npm install
npm run build      # bundle src/ -> dist/ (one-shot)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
```

Load `dist/` as an unpacked extension at `chrome://extensions` (Developer mode on),
or just run the tests, which load it automatically.

## Test (dynamic, in your real Chrome)

Chrome 149 hard-blocks the `--load-extension` command-line switch, so we don't load
the extension that way. Instead we use a **dedicated dev profile** (`.test-profile/`,
gitignored) into which the extension is loaded **once** via the UI; it then auto-loads
from `dist/` on every launch. We spawn that Chrome with a remote-debugging port and
attach with Playwright over CDP — so your normal Chrome/profile is never touched, and
the same dev profile holds your YouTube login for the login-gated features.

### One-time setup

```bash
npm install
npm run build
npm run setup     # opens the dev profile at chrome://extensions
```

In the window that opens:
1. Toggle on **Developer mode**, click **Load unpacked**, choose the `dist/` folder.
2. Open `youtube.com` and sign in once.

Leave that window open while developing.

### Day-to-day

```bash
npm run reload    # rebuild + hot-reload the extension into the running Chrome
npm run drive     # rebuild + reload + quick smoke (injects bar, screenshots)
npm test          # rebuild + reload + full Playwright suite
```

Environment overrides: `SYF_PROFILE` (profile dir), `SYF_CDP_PORT` (default 9222),
`SYF_CHROME` (chrome.exe path).

## API key (for *Find in comments*)

The **Find in comments** feature calls the **YouTube Data API v3**, which needs a free
API key. You set it in the extension via **ℹ Info → API key**. To get one:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **Enable the API:** APIs & Services → **Library** → search **YouTube Data API v3** →
   **Enable** ([direct link](https://console.cloud.google.com/apis/library/youtube.googleapis.com)).
   This is the **only** API you need — ignore the Cloud Trace / Service Usage / Telemetry / etc.
   entries Google pre-enables in every new project.
3. **Wait a few minutes.** A freshly-enabled API takes a bit to propagate; until it does, the
   new-key dialog's *API restrictions* list shows **"No items to display"** and won't let you
   finish. Grab a coffee, then reload the page.
4. APIs & Services → **Credentials** → **Create credentials → API key**.
5. Recommended: **restrict the key to YouTube Data API v3** only.
6. Copy the key (it starts with `AIza…`) and paste it into **ℹ Info → API key**.

You do **not** need to configure the OAuth consent screen — that's only for apps where users
sign in with Google; this key reads public data. Likewise ignore the *"Authenticate API calls
through a service account"* / Vertex / Gemini options in that dialog.

## Privacy

All data stays local. No telemetry, no third-party servers. The extension stores
feedback endpoints, video/channel IDs, titles, your API key, and an optional comment
cache — and never stores Google cookies, session tokens, or credentials.
