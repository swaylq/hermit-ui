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

    // MARK: - Search over the cached prose (apps/dashboard/src/lib/chat-cache/search-core.ts)
    //
    // A hit rendered on the phone and the same hit rendered in the browser
    // have to be the same excerpt. These are the three numbers that decide
    // that: how much text surrounds the match, how many hits one page
    // carries, and where counting matches inside one message stops.

    /// SNIPPET_PAD — characters of context kept on each side of the first
    /// match. Offsets are UTF-16 code units on both sides, because the web
    /// slices a JavaScript string with them.
    static let snippetPad = 70
    /// DEFAULT_PAGE — hits per page for the global search overlay. The
    /// in-session find asks for all of them instead.
    static let searchPageSize = 100
    /// MAX_MATCHES_PER_ROW — matches counted within one message.
    static let maxMatchesPerRow = 200

    // MARK: - Session status (apps/dashboard/src/lib/session-status.ts)
    //
    // Read by the Swift port of `sessionStatusView` (Hermit/SessionStatus.swift).
    // Milliseconds, because that port keeps the original's clocks.

    /// SNAPSHOT_STALE_MS — past this much gateway silence, `state` is a
    /// memory rather than an observation and the dot goes grey.
    static let snapshotStaleMs: Double = 45000
    /// BACKGROUND_RESIDENT_MS — after this much quiet from the agent, an
    /// outstanding background task stops counting as part of the answer.
    static let backgroundResidentMs: Double = 1800000

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

    // MARK: - Theme colours (apps/dashboard/src/app/globals.css)
    //
    // The shadcn variables, which are not palette entries: each is declared
    // twice in that file, under `:root` and under `.dark`, and the browser
    // picks by the scheme in force. So both values come across and the view
    // picks the same way — see `ThemeColor.resolve`.
    //
    // A declaration with an alpha (`--border` in `.dark`) keeps it: the
    // browser composites that hairline against whatever is behind it, and a
    // flattened one would be wrong on every background but the page's own.

    /// `--sidebar` — the session list's own background.
    /// light oklch(0.985 0 0) · dark oklch(0.205 0 0)
    static let sidebar = ThemeColor(
        light: Color(.displayP3, red: 0.9803, green: 0.9803, blue: 0.9803),
        dark: Color(.displayP3, red: 0.0905, green: 0.0905, blue: 0.0905)
    )
    /// `--sidebar-foreground` — a session row's title.
    /// light oklch(0.145 0 0) · dark oklch(0.985 0 0)
    static let sidebarForeground = ThemeColor(
        light: Color(.displayP3, red: 0.0394, green: 0.0394, blue: 0.0394),
        dark: Color(.displayP3, red: 0.9803, green: 0.9803, blue: 0.9803)
    )
    /// `--sidebar-accent` — the row you are looking at.
    /// light oklch(0.97 0 0) · dark oklch(0.269 0 0)
    static let sidebarAccent = ThemeColor(
        light: Color(.displayP3, red: 0.9606, green: 0.9606, blue: 0.9606),
        dark: Color(.displayP3, red: 0.1494, green: 0.1494, blue: 0.1494)
    )
    /// `--muted-foreground` — the agent name, the time, the status word.
    /// light oklch(0.556 0 0) · dark oklch(0.708 0 0)
    static let mutedForeground = ThemeColor(
        light: Color(.displayP3, red: 0.4515, green: 0.4515, blue: 0.4515),
        dark: Color(.displayP3, red: 0.6302, green: 0.6302, blue: 0.6302)
    )
    /// `--background` — the page behind the timeline, and a user bubble's text.
    /// light oklch(1 0 0) · dark oklch(0.145 0 0)
    static let background = ThemeColor(
        light: Color(.displayP3, red: 1.0000, green: 1.0000, blue: 1.0000),
        dark: Color(.displayP3, red: 0.0394, green: 0.0394, blue: 0.0394)
    )
    /// `--foreground` — body text, and the user bubble it is knocked out of.
    /// light oklch(0.145 0 0) · dark oklch(0.985 0 0)
    static let foreground = ThemeColor(
        light: Color(.displayP3, red: 0.0394, green: 0.0394, blue: 0.0394),
        dark: Color(.displayP3, red: 0.9803, green: 0.9803, blue: 0.9803)
    )
    /// `--muted` — the fill behind a system row and an unknown block.
    /// light oklch(0.97 0 0) · dark oklch(0.269 0 0)
    static let muted = ThemeColor(
        light: Color(.displayP3, red: 0.9606, green: 0.9606, blue: 0.9606),
        dark: Color(.displayP3, red: 0.1494, green: 0.1494, blue: 0.1494)
    )
    /// `--border` — a run capsule's hairline.
    /// light oklch(0.922 0 0) · dark oklch(1 0 0 / 10%)
    static let border = ThemeColor(
        light: Color(.displayP3, red: 0.8982, green: 0.8982, blue: 0.8982),
        dark: Color(.displayP3, red: 1.0000, green: 1.0000, blue: 1.0000, opacity: 0.1000)
    )
}

/// One theme variable, in the two schemes it is declared in.
///
/// A `Color` that follows the scheme on its own would be a `UIColor` with a
/// trait-collection block, and that is UIKit — it would stop this file (and
/// every view reading it) from compiling for the Mac, which is how the
/// layouts get looked at without a simulator (tools/render-list.sh).
/// Carrying both and resolving against `\.colorScheme` costs one call and
/// works everywhere SwiftUI does.
struct ThemeColor {
    let light: Color
    let dark: Color
    func resolve(_ scheme: ColorScheme) -> Color { scheme == .dark ? dark : light }
}
