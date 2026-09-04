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
/// The values are the Tailwind v4 classes that file names, converted once here:
///
///     working / needs-you   bg-amber-400
///     unread                bg-rose-500
///     down / stale          bg-zinc-400
///     starting / restarting bg-sky-400
///
/// **Display P3, not sRGB, and not the v3 hexes.** Tailwind 4 defines its
/// palette in OKLCH, and three of these sit outside sRGB — converting to sRGB
/// clips them (amber-400 lands on #FFB900 with the red and blue channels pinned)
/// and the result is visibly flatter than the same colour in Safari on the same
/// phone. It is also not the value anyone remembers: amber-400 was #FBBF24 in
/// Tailwind 3 and is not that any more.
enum StatusPalette {
    /// A turn is in flight, or is parked waiting for you. Both, deliberately:
    /// the web spec gives them one hue and separates them by PULSE — "the same
    /// hue as working (the session is mid-turn), but it pulses at you, not for
    /// you". A Live Activity cannot pulse without spending a push per frame, so
    /// the difference is carried by the things this medium does have: the
    /// symbol, the "去回答" button, the alert, and the relevance score that puts
    /// a blocked session first in the island.
    static let amber = Color(.displayP3, red: 0.9593, green: 0.7385, blue: 0.1175)
    /// Finished, and you have not read it. Red means exactly that here — not an
    /// error. ("上一个对话的任务都处理完了，等待阅读".)
    static let rose = Color(.displayP3, red: 0.9219, green: 0.2406, blue: 0.3555)
    /// Down: no live process. What a turn that died looks like in the sidebar.
    static let zinc = Color(.displayP3, red: 0.6227, green: 0.6226, blue: 0.6596)
    /// Coming up — booting or being recycled. Unused by the activity today, kept
    /// so the next state that needs it does not invent a sixth colour.
    static let sky = Color(.displayP3, red: 0.3061, green: 0.7250, blue: 0.9799)
    /// Ready: alive, idle, caught up. Also unused here — an activity that
    /// reaches "read" has already ended.
    static let emerald = Color(.displayP3, red: 0.2673, green: 0.7268, blue: 0.5082)
}
