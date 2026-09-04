import SwiftUI

/// The session-state colours, taken from the web app rather than picked here.
///
/// `apps/dashboard/src/lib/session-status.ts` carries sway's spec at the top of
/// the file and is the single source of truth for how a session's state renders
/// — the chat header, the sidebar dot and the agent sheet all read it so they
/// cannot drift apart. A Lock Screen showing its own palette would be the same
/// drift, one platform further out, and the first version of this file did
/// exactly that (a cyan "working" that exists nowhere else in the product, and
/// clashes with the crab's own warm shell).
///
/// The channel values are no longer written here at all: `WebContract` is
/// generated from the Tailwind classes those web files name, so this file is
/// only the mapping from a class to what it MEANS on a Lock Screen. Add a
/// colour on the web and it shows up in `WebContract` on the next generate;
/// change one and this side changes with it.
///
///     working / needs-you   bg-amber-400
///     unread                bg-rose-500
///     down / stale          bg-zinc-400
///     starting / restarting bg-sky-400
///     ready                 bg-emerald-500
enum StatusPalette {
    /// A turn is in flight, or is parked waiting for you. Both, deliberately:
    /// the web spec gives them one hue and separates them by PULSE — "the same
    /// hue as working (the session is mid-turn), but it pulses at you, not for
    /// you". A Live Activity cannot pulse without spending a push per frame, so
    /// the difference is carried by the things this medium does have: the
    /// symbol, the "去回答" button, the alert, and the relevance score that puts
    /// a blocked session first in the island.
    static let amber = WebContract.amber400
    /// Finished, and you have not read it. Red means exactly that here — not an
    /// error. ("上一个对话的任务都处理完了，等待阅读".)
    static let rose = WebContract.rose500
    /// Down: no live process. What a turn that died looks like in the sidebar.
    static let zinc = WebContract.zinc400
    /// Coming up — booting or being recycled. Unused by the activity today, kept
    /// so the next state that needs it does not invent a sixth colour.
    static let sky = WebContract.sky400
    /// Ready: alive, idle, caught up. Also unused here — an activity that
    /// reaches "read" has already ended.
    static let emerald = WebContract.emerald500

    // The lighter pair the context readout uses for its NUMBER, where the bar
    // uses the 500s. Same split as components/ctx-bar.tsx.
    static let emerald400 = WebContract.emerald400
    static let rose400 = WebContract.rose400

    /// How full the context window is, in the web app's three bands.
    ///
    /// `components/ctx-bar.tsx`: ≥90% rose, ≥70% amber, else emerald — with the
    /// bar on the 500s and the percentage on the 400s. Copied rather than
    /// re-judged; a phone that called 80% green while the sidebar called it
    /// amber would be worse than no indicator. The two thresholds are read out
    /// of that file by the generator, so "copied" is now literally true.
    static func ctxBar(_ pct: Int) -> Color {
        if pct >= WebContract.ctxDangerPct { return rose }
        if pct >= WebContract.ctxWarnPct { return amber }
        return emerald
    }

    static func ctxText(_ pct: Int) -> Color {
        if pct >= WebContract.ctxDangerPct { return rose400 }
        if pct >= WebContract.ctxWarnPct { return amber }   // amber-400 is already the 400
        return emerald400
    }

    /// A status dot's Tailwind class, resolved to what SwiftUI draws.
    ///
    /// `sessionStatusView` (ported in `Hermit/SessionStatus.swift`) returns the
    /// web's class string verbatim — `bg-amber-400`, `bg-emerald-500/30` — so
    /// the fixture can compare it against the browser character for character.
    /// This is the one place that turns such a string into pixels.
    ///
    /// The `/N` suffix is Tailwind's opacity, in PERCENT. It carries meaning in
    /// two of the five: `bg-amber-400/50` is "something is running but it is not
    /// moving", `bg-emerald-500/30` is "idle and nothing is up". Dropping the
    /// suffix would silently merge each with the state above it.
    ///
    /// Returns nil for a class this build has never heard of, rather than
    /// guessing a colour — the caller draws its own "unknown" mark. Web and app
    /// ship on different schedules, and `ios-contract.test.ts` is what turns a
    /// new colour on the web into a red test here rather than a blank dot on a
    /// phone.
    static func dot(_ cls: String) -> (color: Color, opacity: Double)? {
        let body = cls.hasPrefix("bg-") ? String(cls.dropFirst(3)) : cls
        let parts = body.split(separator: "/", maxSplits: 1)
        var opacity = 1.0
        if parts.count == 2 {
            guard let pct = Double(parts[1]) else { return nil }
            opacity = pct / 100
        }
        switch String(parts[0]) {
        case "amber-400": return (amber, opacity)
        case "rose-500": return (rose, opacity)
        case "zinc-400": return (zinc, opacity)
        case "sky-400": return (sky, opacity)
        case "emerald-500": return (emerald, opacity)
        default: return nil
        }
    }
}
