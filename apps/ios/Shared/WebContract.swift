// GENERATED FILE — do not edit by hand.
//
// Rendered from the web app by apps/dashboard/scripts/gen-ios-contract.ts:
//
//     pnpm --filter @hermit-ui/dashboard gen:ios-contract
//
// Everything here is a number the phone has to agree with the web on, and
// every one of them used to be a hand-copy. Change it where the comment says
// it comes from and regenerate — a Swift-only edit is reverted by the next
// run, and `pnpm --filter @hermit-ui/dashboard test` is red until this file
// matches its sources again.
//
// The names below are deliberately the WEB's names. Swift-side meaning
// (which colour is "needs you", how long a stream may sit quiet) belongs to
// the hand-written files that read these — StatusPalette, HermitStream,
// LiveActivityManager — where it can carry a comment worth reading.

import SwiftUI

enum WebContract {

    // MARK: - The live window (apps/dashboard/src/lib/chat-window.ts)

    /// INITIAL_WINDOW — the newest N messages, the only window the stream carries.
    static let timelineLimit = 60
    /// TIMELINE_DIGEST — ask for the window as the collapsed timeline renders it.
    static let timelineDigest = true

    // MARK: - Stream reconnect (apps/dashboard/src/app/chat/page.tsx)

    /// BACKOFFS, in seconds.
    static let streamBackoffs: [TimeInterval] = [1, 2, 5]
    /// IDLE_DEAD_MS, in seconds — the server pings every 15s, so silence past
    /// this is a half-open connection, not a quiet session.
    static let streamIdleDeadline: TimeInterval = 35

    // MARK: - Live Activity staleness (apps/dashboard/src/server/push/live-activity.ts)

    /// WORKING_STALE_MS, in seconds. The server puts this same distance into
    /// every `staleDate` it pushes, so a smaller value here dims an activity
    /// the server still considers fresh.
    static let workingStaleAfter: TimeInterval = 900
    /// BLOCKED_STALE_MS, in seconds.
    static let blockedStaleAfter: TimeInterval = 21600
    /// LINGER_MS, in seconds.
    static let lingerAfterEnd: TimeInterval = 300

    // MARK: - Context bands (apps/dashboard/src/components/ctx-bar.tsx)

    static let ctxDangerPct = 90
    static let ctxWarnPct = 70

    // MARK: - Palette
    //
    // Exactly the Tailwind classes the two files above name, resolved through
    // Tailwind's own theme.css and converted from oklch to Display P3 — not to
    // sRGB, which clips three of them, and not to the v3 hexes, which are a
    // different palette (amber-400 has not been #FBBF24 since Tailwind 3).

    /// `amber-400` — oklch(82.8% 0.189 84.429)
    static let amber400 = Color(.displayP3, red: 0.9592, green: 0.7385, blue: 0.1183)
    /// `emerald-400` — oklch(76.5% 0.177 163.223)
    static let emerald400 = Color(.displayP3, red: 0.3347, green: 0.8196, blue: 0.5916)
    /// `emerald-500` — oklch(69.6% 0.17 162.48)
    static let emerald500 = Color(.displayP3, red: 0.2671, green: 0.7268, blue: 0.5084)
    /// `rose-400` — oklch(71.2% 0.194 13.428)
    static let rose400 = Color(.displayP3, red: 0.9429, green: 0.4308, blue: 0.5031)
    /// `rose-500` — oklch(64.5% 0.246 16.439)
    static let rose500 = Color(.displayP3, red: 0.9218, green: 0.2407, blue: 0.3557)
    /// `sky-400` — oklch(74.6% 0.16 232.661)
    static let sky400 = Color(.displayP3, red: 0.3060, green: 0.7250, blue: 0.9802)
    /// `zinc-400` — oklch(70.5% 0.015 286.067)
    static let zinc400 = Color(.displayP3, red: 0.6226, green: 0.6226, blue: 0.6598)
}
