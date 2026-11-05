# Safari on iPhone and iPad

Development version **0.1.3** shares TypeScript with Chromium and includes an iOS
Safari Web Extension wrapper. Personal use is the initial target. Enable website
access in Safari; this extension cannot modify the native YouTube app.

## Architecture and behavior

- `npm run build` still produces Chromium's `dist`. `npm run build:safari` creates
  `dist-safari`, targeting Safari 18. Both match desktop/mobile YouTube hosts.
  Safari omits the embed script, DNR rules, and web-accessible settings pages.
- The shared page adapter selects desktop/mobile markup from rendered elements.
  Mobile mounts include `ytm-slim-video-metadata-renderer` and its section variant.
  The bridge observes the site's own fetch/XHR innertube and `pbj=1` navigation
  responses, including XSSI-prefixed JSON. Mobile boot data is not reused on a
  different route. Player context must match the current video ID.
- Authenticated feedback remains in the isolated script. Its signed origin is the
  current HTTPS `www.youtube.com` or `m.youtube.com` origin, with live client and
  account context. Missing cookies fail before sending. No tokens are fabricated.
- The phone toolbar has two primary actions and **More**, with 44px minimum touch
  heights. Settings open in a tab. Home-chip discovery excludes Explore launchers;
  feed-filter CSS includes mobile cards and preserves channel exceptions.
- Safari appends `src/content/safari-theme.css` to its content stylesheet. Toolbar,
  disclosure, dialogs, and toasts follow `prefers-color-scheme` with their own
  paired foreground/background colors. Unavailable buttons keep readable muted
  text; the surrounding page's color scheme is not changed.
- Settings, the popup, and the foreground My Activity review also follow system
  appearance. Touch input fields use 16px fonts, and touch buttons have 44px targets,
  including iPad layouts. Settings wrap the channel-exception form on narrow screens.
- Safari startup does not require `onSuspend`, windows, or DNR. Capture and quota
  writes finish during message processing. Log/undo acknowledgments wait for
  storage on both platforms.
- Comment search uses an extension tab and one reusable YouTube tab for matches
  and author links. The in-memory comment cache stays in the search tab; browser
  discarding/reloading that tab loses the cache and requires another scan.
- **Forget recent** opens the correctly routed foreground My Activity page with
  an isolated review panel. The user scans *loaded* activity, then confirms the
  exact token snapshot. Deletion stops on backgrounding, account-route changes,
  or the first unconfirmed response; it never resumes automatically. After an
  ambiguous response, reload My Activity and review again. No hidden tab is needed.
- Safari Pause history uses the active-tab fetch path only. If mobile YouTube
  does not expose the pause/play control, it reports failure without submitting
  another token. Chromium retains its existing background-helper fallback.

## Build and installation

The checked-in wrapper is at
`D:\projects\AI\SethsYoutubeFixer\platforms\safari\SethsYouTubeFixer`.
Xcode **27.2** generated its `project.xcproj` format. Resource references are
relative to the generated `dist-safari` folder; never maintain copied JavaScript
inside the wrapper. The deployment target is iOS 18; older versions are untested.

Run from `D:\projects\AI\SethsYoutubeFixer`:

```powershell
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run build:safari
npm run safari:check
npm run safari:install
```

`safari:check` validates resources using native `WKWebExtension` and builds the
whole iOS app unsigned. It opens neither Safari nor a WebView. `safari:build`
signs; `safari:install` also installs using `devicectl`, without launching apps
or interacting with the phone. Each run uploads only built web resources, the
wrapper, and the validator to a fresh `incoming-*` folder under the remote root.
Build products/cache are under `build`, and the Xcode log is `build.log`. Old
input directories are retained; no remote checkout is deleted.

Configure the ignored file
`D:\projects\AI\SethsYoutubeFixer\platforms\safari\build.local.json`:

```json
{
  "host": "developer@your-mac.local",
  "remoteRoot": "/Users/developer/syf-ios-build",
  "team": "YOURTEAMID",
  "device": "YOUR-DEVICE-IDENTIFIER",
  "loginSession": true
}
```

Environment overrides: `SYF_SAFARI_HOST`, `SYF_SAFARI_ROOT`, `SYF_APPLE_TEAM`, and
`SYF_IOS_DEVICE`. Optional `hostKeyAlias` / `SYF_SAFARI_HOST_KEY_ALIAS` lets a
verified IP use the Mac's existing SSH host key when local-name resolution is
intermittent. Strict host-key checking stays on. Keep passwords, certificates,
private keys, provisioning profiles, and machine/account details out of Git.
The wrapper has no hardcoded development team.

To install on another paired device, set `SYF_IOS_DEVICE` for that invocation;
leave the local configuration's default device unchanged. Both iPhone and iPad
are included in the wrapper's supported device families. The current iPad was
already registered in the development provisioning profile.

If SSH cannot access an otherwise unlocked signing key, use `loginSession: true`
or `SYF_SAFARI_LOGIN_SESSION=1`. This runs just the compiler/signing command as a
temporary LaunchAgent in the existing Mac login session, then unloads it. Keep
that Mac user logged in and the signing keychain unlocked. It does not launch
Xcode, Safari, or the app. The installation command also queries the phone to
verify that the installed version matches the built app.

After installing, enable **Settings → Apps → Safari → Extensions → Seth’s YouTube
Fixer**, then grant access on YouTube. Allow My Activity for Forget recent, and
Google APIs for comment search. Sign in within Safari. The containing app includes
these instructions. Chrome's settings/session are not transferred.

## Verification status — 2026-11-05

Verified:

- TypeScript, Chromium/Safari bundles, and **26 offline tests**.
- Public mobile YouTube JavaScript confirms metadata/chip names and PBJ navigation.
- Native macOS WebKit resource validation: `injected=1 background=1 errors=0`.
- Full unsigned and signed iOS app/embedded extension builds in Xcode 27.2.
- Deep/strict signature validation and installation on the physical iPhone 17 Pro
  and **13-inch M4 iPad Pro**. Both device app queries confirm **0.1.3, build 5**.
- Build 5 replaces the upscaled icon with high-resolution play/wrench artwork,
  exports all browser/store/iOS sizes, and lets iOS generate icon appearance
  treatments. The original artwork and exact generation prompt are in
  `store-assets/icon-master.png` and `store-assets/icon-artwork.txt`.
- Edited CSS parses for Safari 18. Exported icon dimensions and opaque RGB PNG
  format pass checks; 32px and 128px icons were inspected as local image files.
- Seth confirmed that the watch-page controls appear on the iPhone. He reported
  black text on nearly black buttons in build 3; build 4 replaces mixed YouTube
  CSS variables/fallbacks with complete light/dark palettes. CSS parsing and
  Safari-only bundling pass; tested button color pairs exceed 4.5:1 contrast.
  Seth subsequently reported that the updated build seems to work and approved
  committing it. This is a general phone check, not verification of every case below.

SSH signing initially failed with `errSecInternalComponent`; signing in the
existing Mac login session succeeded after Seth unlocked the keychain. Xcode's
CLI still prints a package-install authorization warning even for `--help`, but
`devicectl` installation and its subsequent structured app query both succeeded.
No device app was launched or Safari session controlled, and no real feedback
or deletion was performed by the agent. **The detailed Safari acceptance cases
below remain unverified individually.**

The packager warned about the `world` manifest key. Native WebKit validation
accepted the resources with no errors. Retain MAIN/ISOLATED separation and check
the handshake on the phone; don't move authenticated writes into page-world code.

Device acceptance still required (Seth operates the phone unless explicitly
authorizing automation):

1. Enable/deny/regrant permissions; check settings, filters, toolbar, Home → watch
   → next-video navigation, refresh, and Request Desktop Website.
2. Check real mobile token availability, deliberately apply/undo one action, and
   inspect the log. Verify Google/Brand account switching clears stale tokens.
3. Check topics, thumbnail pause/resume, full screen, history pause/resume,
   portrait/landscape, lock/unlock, and Safari background/foreground transitions.
4. Search with a real key, visit a comment, and return to retained results.
5. Review the correct My Activity account and confirm one chosen test item's
   deletion. Verify its absence after reload; check interruption handling separately.

Offline tests cover manifests, layout adapters, mobile membership exceptions,
fetch/XHR/PBJ capture, startup without optional APIs, persistence, mobile-origin
apply/undo, signed-out rejection, comment-tab reuse/cache, exact reviewed deletion,
background interruption, and account routing. Existing Chrome/CDP UI tests need
explicit browser-control permission and were not run.

## Remaining work found in the build 5 review

- **Account routing for log Undo/Redo:** `relayReplay` in
  `src/background/service-worker.ts` picks the first open YouTube tab, without
  checking that tab's account. Account-switch cache clearing reduces stale state
  but does not make this routing account-aware. Harden this before relying on log
  replay with different accounts open across tabs. A future fix should verify
  both action ownership and the target tab's live account immediately before submit.
- **Comment search durability:** results and scan position are held in the search
  page's memory. Safari discarding/reloading that tab loses them. Persisted
  checkpoints and explicit resume are not implemented.
- **Activity coverage:** Forget recent reviews only currently loaded items. It
  does not promise an exhaustive scan of the selected time window; load additional
  activity before scanning. The exact reviewed-token deletion guard remains in place.
- **Device acceptance:** account switches, feedback/undo, background/lock/resume,
  permissions, and one deliberate reviewed deletion still need the manual cases
  above. The iPad has been installed, but its Safari UI has not been operated by
  the agent. Build 5's theme/touch changes also await on-device appearance checks.

## References

- [Apple: Packaging](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- [Apple: Compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)
- [Apple: Device installation](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
- [WebKit: onSuspend](https://bugs.webkit.org/show_bug.cgi?id=294458)
- [Apple: Diagnosing signing/keychain errors](https://developer.apple.com/forums/thread/712005)
