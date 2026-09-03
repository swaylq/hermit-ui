#!/usr/bin/env bash
# Archive, sign and upload a build to TestFlight — with no Apple ID signed into
# Xcode on this machine. Everything comes from an App Store Connect API key.
#
#   apps/ios/release.sh <build-number> [--no-upload]
#
# The build number must be unique and increasing; App Store Connect rejects a
# repeat, and it is the one thing this script will not guess for you.
#
# Identifiers come from `apps/ios/.release.env` (gitignored, next to this file):
#
#   ASC_KEY_ID=ABCDE12345        # App Store Connect API key, App Manager role
#   ASC_ISSUER_ID=<uuid>         # Users and Access → Integrations
#   ASC_TEAM_ID=ABCDE12345
#   ASC_PROFILE="<name of the App Store provisioning profile>"
#
# The key itself is never a file in the repo and never an argument: it arrives
# base64-encoded in ASC_KEY_P8_B64 (or ASC_KEY_P8_HERMIT_B64, which is what the
# encrypted store calls it here), and is written to a mode-700 temp dir that is
# removed on the way out, success or failure:
#
#   secret exec ASC_KEY_P8_HERMIT_B64 -- apps/ios/release.sh 3
#
# One-time setup — the distribution certificate and the App Store profile — is
# NOT here. It is a handful of API calls you make once, written up under
# "Signing without an Xcode account" in README.md. This script assumes the
# resulting identity is already in a keychain on the search list; check with
#   security find-identity -v -p codesigning
set -euo pipefail

cd "$(dirname "$0")"

BUILD="${1:-}"
[ -n "$BUILD" ] || { echo "usage: release.sh <build-number> [--no-upload]" >&2; exit 1; }
UPLOAD=1
[ "${2:-}" = "--no-upload" ] && UPLOAD=0

[ -f .release.env ] && . ./.release.env
KEY_B64="${ASC_KEY_P8_B64:-${ASC_KEY_P8_HERMIT_B64:-}}"
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_TEAM_ID ASC_PROFILE; do
  [ -n "${!v:-}" ] || { echo "missing $v (put it in apps/ios/.release.env)" >&2; exit 1; }
done
[ -n "$KEY_B64" ] || { echo "no key: run under \`secret exec ASC_KEY_P8_HERMIT_B64 --\`" >&2; exit 1; }

command -v xcodegen >/dev/null || { echo "need xcodegen: brew install xcodegen" >&2; exit 1; }

WORK=$(mktemp -d); chmod 700 "$WORK"
OUT="${HERMIT_RELEASE_OUT:-$WORK/out}"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/private_keys"
printf %s "$KEY_B64" | base64 -d > "$WORK/private_keys/AuthKey_$ASC_KEY_ID.p8"
chmod 600 "$WORK/private_keys/AuthKey_$ASC_KEY_ID.p8"

# Written per run because it carries the team id, which is not ours to commit.
cat > "$WORK/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$ASC_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>
    <key>ai.swaylab.hermit</key><string>$ASC_PROFILE</string>
  </dict>
  <key>uploadSymbols</key><true/>
  <key>destination</key><string>export</string>
</dict></plist>
PLIST

xcodegen generate >/dev/null

echo "── archive (build $BUILD)"
# -allowProvisioningUpdates plus the key is what replaces a signed-in Xcode: it
# registers the DEVELOPMENT certificate and team profile this step needs.
xcodebuild -project Hermit.xcodeproj -scheme Hermit -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$WORK/Hermit.xcarchive" archive \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$WORK/private_keys/AuthKey_$ASC_KEY_ID.p8" \
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  DEVELOPMENT_TEAM="$ASC_TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD" | tail -2

echo "── export"
# Deliberately NOT -allowProvisioningUpdates: asking Xcode to cloud-sign the
# DISTRIBUTION certificate fails with "Cloud signing permission error" unless the
# API key is Admin. Manual signing against the profile you made once avoids it.
rm -rf "$OUT"
xcodebuild -exportArchive -archivePath "$WORK/Hermit.xcarchive" \
  -exportOptionsPlist "$WORK/ExportOptions.plist" -exportPath "$OUT" | tail -2

echo "── the ipa says:"
UNZ="$WORK/unz"; mkdir -p "$UNZ"
(cd "$UNZ" && unzip -q "$OUT/Hermit.ipa")
codesign -d --entitlements - --xml "$UNZ/Payload/Hermit.app" 2>/dev/null \
  | plutil -p - | grep -e application-identifier -e aps-environment || true
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' -c 'Print :CFBundleVersion' \
  "$UNZ/Payload/Hermit.app/Info.plist"

if [ "$UPLOAD" = 0 ]; then echo "── skipping upload (--no-upload); ipa: $OUT/Hermit.ipa"; exit 0; fi

echo "── validate + upload"
cd "$WORK"   # altool finds the key as ./private_keys/AuthKey_<id>.p8
xcrun altool --validate-app -f "$OUT/Hermit.ipa" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" | tail -4
xcrun altool --upload-app -f "$OUT/Hermit.ipa" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" | tail -5
