import UIKit

/// The taps the page asks for.
///
/// WebKit on iOS has no `navigator.vibrate` — not in Safari, not in an installed
/// PWA, not here. A web page on this platform cannot produce a haptic at all, so
/// every buzz in the dashboard comes through this file. That also means there is
/// nothing to fall back to: if this is wrong, the feature is simply absent.
///
/// Two things decide whether a tap is felt at the right moment:
///
/// · **Prepare first.** An unprepared generator spins the Taptic Engine up on
///   first use, and the buzz lands tens of milliseconds late. The first buzz of a
///   press-and-hold is the one that says "recording started" — late reads as a
///   dropped input, so the composer sends `prepare` on pointerdown, ~260ms before
///   the hold is confirmed.
/// · **Keep the generators.** Building one per call throws the warm engine away
///   every time, which is the same mistake with extra allocations.
///
/// Main-thread only, like `AppConfig.knownHosts`: every caller is the WebKit
/// script-message handler, which WebKit already delivers on the main queue.
/// `UIFeedbackGenerator` requires that anyway.
///
/// Not felt, through no fault of this code: Low Power Mode, Settings → Sounds &
/// Haptics → System Haptics off, and the app not being frontmost. All three are
/// silent — there is no error and no callback, so a device that reports "no
/// vibration" needs those checked before this file does.
enum Haptics {
    // .light / .medium rather than the iOS 13 .soft / .rigid: the two used here
    // are a confirmation and a dismissal, which want a definite edge, not a
    // cushioned one.
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    private static let selection = UISelectionFeedbackGenerator()
    private static let notice = UINotificationFeedbackGenerator()

    /// Warm the engine. Cheap and idempotent; the OS lets it idle back down by
    /// itself after a second or two, so there is nothing to release.
    static func prepare() {
        light.prepare()
        medium.prepare()
        selection.prepare()
        notice.prepare()
    }

    /// Play one by name.
    ///
    /// An unknown name is ignored rather than approximated. The dashboard ships
    /// continuously and this app ships through TestFlight, so a page that learned
    /// a new style before the installed shell did is the normal case — it should
    /// degrade to silence, never to the wrong sensation.
    static func play(_ style: String) {
        switch style {
        case "prepare":   prepare()
        case "light":     light.impactOccurred()
        case "medium":    medium.impactOccurred()
        case "selection": selection.selectionChanged()
        case "success":   notice.notificationOccurred(.success)
        case "warning":   notice.notificationOccurred(.warning)
        default:          break
        }
    }
}
