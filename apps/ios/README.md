# Hermit iOS

A native shell around `dash.swaylab.ai`. It exists for two things a web page on
iOS cannot do:

1. **Microphone without the prompt.** iOS re-asks for permission on every single
   `getUserMedia` call, which makes the dashboard's voice input unusable in Safari
   or an installed PWA. Inside a `WKWebView` the host app answers instead
   (`WebViewController.swift`), so the system asks once and the web layer never
   sees a prompt again.
2. **Push notifications.** `WKWebView` has no Push API at all, so notifications go
   through native APNs — registered by the app, sent by the dashboard
   (`apps/dashboard/src/server/push/`).

   Note that push is **no longer a reason to build this app**. The dashboard now
   also speaks Web Push (to the installed PWA) and Bark, neither of which needs a
   paid Apple Developer account — see `docs/no-app-push-design.md`. APNs here is
   one transport among three, and everything below still applies if you want it.
   The microphone is the reason the shell exists.

Everything else is the existing web app, unmodified.

Design notes: `docs/ios-shell-design.md`.

## Build

The `.xcodeproj` is generated, not committed:

```sh
brew install xcodegen     # once
cd apps/ios
xcodegen generate
open Hermit.xcodeproj
```

In Xcode: select the **Hermit** target → *Signing & Capabilities* → set your Team.
Automatic signing handles the rest. `Push Notifications` is already declared via
`Hermit/Hermit.entitlements`.

To check the sources compile without a full device build:

```sh
swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  -target arm64-apple-ios17.0 Hermit/*.swift
```

## Install

- **Own device** — plug in, pick it in Xcode's device menu, Run. A paid
  developer account's provisioning profile lasts a year.
- **Other people** — Archive → distribute to TestFlight (internal testing, up to
  100 testers, no App Review).
- **Not the App Store.** A web-view shell runs straight into review guideline 4.2
  (minimum functionality) for no benefit here.

## Server setup for push

The dashboard sends the pushes, so the APNs credentials live there, not in this
project. Create an APNs auth key (Apple Developer → Certificates, Identifiers &
Profiles → Keys → **Apple Push Notifications service**), download the `.p8` once,
then put these in `apps/dashboard/.env` on the VPS:

```
APNS_KEY_P8="-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----"
APNS_KEY_ID=ABCD123456
APNS_TEAM_ID=EFGH789012
APNS_BUNDLE_ID=ai.swaylab.hermit
```

Literal `\n` in the value is fine — the loader converts it back. The `.p8` is a
private key: keep the canonical copy in the `secret` store, never in git.

With any of the four missing, the push subsystem no-ops and logs one line at
startup. Nothing else breaks.

### Sandbox vs production

An Xcode-installed build's device token only works against APNs **sandbox**; a
TestFlight build's only against **production**. The app reads which one it is from
its embedded provisioning profile (`ProvisioningProfile.swift`) and reports it at
registration, so moving a phone from Xcode to TestFlight fixes itself on the next
launch — no server change.

## How the pieces connect

```
AppDelegate            APNs registration → device token
   └─ NativeBridge     hands the token to the page (and replays taps that
                       arrived before it finished loading)
        └─ lib/native-bridge.ts   registers the token once per machine key,
                                  using the web app's own authenticated client
```

The shell holds **no credentials**. It never sees a machine key; the web layer
does the registering. That keeps auth in one place and means a phone carrying
three machine keys is subscribed to all three machines.

## Verifying push end to end

Needs a real device — the simulator has no APNs.

1. Launch the app, accept the notification prompt.
2. Check it registered: the console logs `[hermit] push registered for N/M machines`.
3. Trigger a test from the dashboard: `push.test` sends to every device on the
   current machine (it uses the `host` kind, so it goes out urgent and a Focus
   mode won't swallow it).
4. Then the real thing: have an agent ask for a permission decision and confirm
   the notification arrives and opens the right session.

## Verify it end to end (`smoke.sh`)

One command builds the app, installs it on a simulated iPhone, signs in and
screenshots the screens that behave differently inside the shell:

```sh
brew install xcodegen                       # once
secret exec MAC001_KEY -- apps/ios/smoke.sh # against the deployed dashboard
```

The machine key is read from the environment (`HERMIT_TEST_KEY`, or `MAC001_KEY`
as `secret exec` provides it) and forwarded to the test runner, so it never
reaches argv or the repository; the result bundle, which records the runner's
environment, is deleted at the end. Without a key the run still builds, launches
and shoots the sign-in screen, then stops.

To verify a change to `apps/dashboard` *before* it ships, point the shell at a
build running on this Mac:

```sh
cd apps/dashboard && npx next build && PORT=4102 npx tsx server.ts &
secret exec MAC001_KEY -- env HERMIT_ORIGIN=http://localhost:4102 apps/ios/smoke.sh
```

(Still through `secret exec` — typing the key on the command line puts it in shell
history, which is the one place this whole arrangement is trying to keep it out of.)

`-hermitOrigin` is a launch argument the app reads out of `UserDefaults`
(`AppConfig.swift`); plain HTTP to `localhost` works because of the
`NSAllowsLocalNetworking` exception in `Info.plist`, which permits nothing on the
public internet. Screenshots land in `$HERMIT_SHOT_DIR` (default `apps/ios/shots`,
gitignored).

There are unit tests too — `HermitTests/AppConfigTests.swift`, covering
`AppConfig.isInternal`, which decides whether a URL stays in the app or is handed
to Safari. Both targets run under the same `Hermit` scheme, so `smoke.sh` covers
them; on their own: `xcodebuild test -only-testing:HermitTests …`.

The end-to-end test is `HermitUITests/SmokeTests.swift`. It asserts the things that
are specific to being an app rather than a tab: no system permission prompt on
the sign-in screen, the sign-in gate actually clearing, and each route rendering
content.
