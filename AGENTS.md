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
- **Next:** Feature 1b — real feedback POST (`/youtubei/v1/feedback`, needs SAPISIDHASH auth
  header), gated on first verifying a replayed token actually registers (mutates the real
  account, so test deliberately). Then improve coverage + add Undo.

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
