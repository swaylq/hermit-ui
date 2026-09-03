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

**Before you plug in a phone, know what that costs.** The microphone and push are
the two things only a device can prove, so real-device runs are expected — but
they create storage `smoke.sh` cannot reach, because it is not the simulator's
and not the build's:

| Path | Grows by | Cleaned by |
|---|---|---|
| `~/Library/Developer/Xcode/iOS DeviceSupport/<ios version>` | a few GB, one copy per iOS version the device ever runs | nobody — delete old versions by hand |
| `~/Library/Developer/Xcode/Archives` | one per archive | nobody |

`smoke.sh`'s cleanup covers the simulator path completely (DerivedData, the
result bundle, and `simctl erase` on the device it booted). None of it touches
the two above. On a machine whose system disk lives near 90% — this one — that
difference has been the margin twice.

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

## TestFlight

The short version: **internal testing needs no App Review**, so the whole path is
archive → upload → add yourself as a tester → install. External testing is a
different thing with a real review attached — see the bottom of this section.

**Once, before the first build**

1. A paid Apple Developer Program membership. The free tier cannot get the
   `aps-environment` entitlement, so it cannot build this app at all.
2. A signing identity on the build machine. Signing in to Xcode
   (Settings → Accounts) is the easy way; if the machine has no GUI session, or
   the Apple ID's 2FA is not at hand, see *Signing without an Xcode account*
   below — an API key is enough for the whole path.
3. Register the bundle id `ai.swaylab.hermit` on the developer portal, with the
   Push Notifications capability enabled.
4. App Store Connect → My Apps → **+** → New App, same bundle id. TestFlight
   builds go to this record; you never have to submit it for sale.

**Every build**

```sh
secret exec ASC_KEY_P8_HERMIT_B64 -- apps/ios/release.sh <build-number>
```

`release.sh` is the whole sequence below in one command — archive, export, check
what the ipa actually says, validate, upload. Identifiers live beside it in
`.release.env` (gitignored); the key arrives base64-encoded in the environment and
is written to a temp dir that goes away on the way out. `--no-upload` stops after
the ipa. The rest of this section is what it does, for when it breaks.

The build number has to be unique and increasing — App Store Connect rejects a
repeat. `CURRENT_PROJECT_VERSION` lives in `project.yml`; the commit count is a
reasonable source for it:

```sh
cd apps/ios
xcodegen generate
xcodebuild archive \
  -project Hermit.xcodeproj -scheme Hermit \
  -destination 'generic/platform=iOS' \
  -archivePath build/Hermit.xcarchive \
  CURRENT_PROJECT_VERSION=$(git rev-list --count HEAD) \
  DEVELOPMENT_TEAM=<your team id>
xcodebuild -exportArchive \
  -archivePath build/Hermit.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export
```

`ExportOptions.plist` is a four-line file (`method: app-store-connect`,
`teamID`, `uploadSymbols: true`, `signingStyle: automatic`); it is not committed
because it carries a team id.

Upload with an App Store Connect API key (Users and Access → Integrations → keys;
the `.p8` downloads once). Keep the key in the encrypted store, never on the
command line:

```sh
secret exec ASC_KEY_P8 -- sh -c 'printf %s "$ASC_KEY_P8" > "$TMPDIR/AuthKey.p8" &&
  xcrun altool --upload-app -f build/export/Hermit.ipa -t ios \
    --apiKey <key id> --apiIssuer <issuer id>; rm -f "$TMPDIR/AuthKey.p8"'
```

Processing takes a few minutes, then the build shows up under TestFlight. Add
yourself under **Internal Testing** (up to 100 people from your own team, no
review), and it installs through the TestFlight app.

**Signing without an Xcode account**

A machine with zero signing identities (`security find-identity -v -p codesigning`
prints `0 valid identities found`) can still produce a distribution build. Everything
below runs from an App Store Connect API key with the **App Manager** role; no Apple ID
is typed anywhere.

1. **Archive.** Pass the key to `xcodebuild` and it registers a development
   certificate and a team profile for you:

   ```sh
   xcodebuild archive ... -allowProvisioningUpdates \
     -authenticationKeyPath /abs/AuthKey_<id>.p8 \
     -authenticationKeyID <id> -authenticationKeyIssuerID <issuer>
   ```

2. **Distribution certificate.** `-exportArchive` will try to make one the same way and
   fail with `Cloud signing permission error` — Xcode's cloud signing needs an *Admin*
   key. The plain certificates endpoint does not: generate the key pair and CSR locally,
   then `POST /v1/certificates` with `certificateType: DISTRIBUTION` and the CSR. The
   private key stays on the machine, which is the point — the team's existing
   certificates are useless here, since their private keys live on whoever created them.

3. **Provisioning profile.** `POST /v1/profiles` with `profileType: IOS_APP_STORE`, the
   bundle id resource (`GET /v1/bundleIds?filter[identifier]=...`) and the certificate
   from step 2. Write the returned `profileContent` (base64) to
   `~/Library/Developer/Xcode/UserData/Provisioning Profiles/<uuid>.mobileprovision`.

4. **Keychain.** Wrap key + certificate into a `.p12` and import it into a keychain
   created for this, so the password is one you chose rather than the login one:

   ```sh
   security create-keychain -p "$PW" "$KC"
   security unlock-keychain -p "$PW" "$KC"
   security import dist.p12 -k "$KC" -P "$P12PW" -T /usr/bin/codesign -A
   security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC"
   security list-keychains -d user -s <existing list> "$KC"
   ```

   Give the `.p12` a real password — with an empty one, `security import` fails with
   `MAC verification failed`. Keep it: this is the only copy of that private key, and a
   team is limited to two distribution certificates, so losing it means revoking
   somebody else's.

5. **Export** with `signingStyle: manual`, `signingCertificate: Apple Distribution` and
   a `provisioningProfiles` entry mapping the bundle id to the profile name from step 3.

**Things that bite, in the order they bite**

| | |
|---|---|
| Missing privacy manifest | Upload is accepted, then bounced by email (`ITMS-91053`). `Hermit/PrivacyInfo.xcprivacy` handles it — one entry, `UserDefaults`, because `AppConfig` reads the `-hermitOrigin` launch argument. |
| Export compliance | Otherwise every upload waits on a web form. Answered in `Info.plist` (`ITSAppUsesNonExemptEncryption` = false: the only cryptography here is HTTPS, which is exempt). |
| `aps-environment` | The entitlements file says `development`; Xcode's distribution flow substitutes `production`. Do not hand-edit it — `ProvisioningProfile.swift` reads the value back at runtime and reports it, so the first TestFlight build tells you which APNs host to send to. If push is silent and the server logs `BadDeviceToken`, that is this. |
| Push does not work in the simulator | There is no APNs there at all. TestFlight on a real phone is the first time the push half of this app can be tested — which, with the microphone, is the entire reason it exists. |

**External testing is not the same errand.** It goes through Beta App Review,
and two things about this app are exactly what that review pushes back on:
guideline 4.2 treats a wrapper around a website as thin, and a reviewer with no
machine key sees a sign-in screen and nothing else. If it ever needs to go that
way, it needs a demo key and a case for what the native layer adds — the
microphone behaviour and APNs, neither of which the web can do. For a handful of
people on your own team, internal testing avoids the question entirely.

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
