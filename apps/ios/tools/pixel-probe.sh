#!/usr/bin/env bash
# Print a vertical scan of a screenshot's colours. See tools/pixel-probe.swift.
#
#   apps/ios/tools/pixel-probe.sh shots/25-timeline-beginning.png [x-fraction] [step]
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="$(mktemp -d)/pixel-probe"
swiftc -O -o "$BIN" tools/pixel-probe.swift
"$BIN" "$@"
