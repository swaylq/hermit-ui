#!/usr/bin/env bash
# Draw the native session detail panel to PNGs so a change can be looked at
# before it ships — on this Mac, no simulator. Not part of any target.
#
#   apps/ios/tools/render-detail.sh [outdir]     # default: apps/ios/shots
#
# Possible because SessionDetailView is SwiftUI over SessionDetailCore's answer,
# and because SessionDetailModel can be POSED (`pose(detail:config:…)`) instead
# of pointed at a server. The UIKit controller that presents it is behind
# `#if canImport(UIKit)`, so none of it reaches this build.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-shots}"
mkdir -p "$OUT"
BIN="$(mktemp -d)/render-detail"
swiftc -O -o "$BIN" \
  Shared/StatusPalette.swift Shared/WebContract.swift \
  Hermit/SessionDetailCore.swift Hermit/SessionDetailView.swift \
  Hermit/SessionDetailController.swift \
  Hermit/WebBackends.swift Hermit/WebLabels.swift Hermit/SessionStatus.swift \
  Hermit/SessionMeta.swift Hermit/SessionListItem.swift Hermit/ContentBlock.swift \
  Hermit/HermitAPI.swift Hermit/KeyStore.swift Hermit/Keychain.swift \
  Hermit/AppConfig.swift \
  tools/render-detail.swift
"$BIN" "$OUT"
echo "→ $OUT"
