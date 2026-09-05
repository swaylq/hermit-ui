import Foundation

/// The mic slot, and the press-and-hold gesture behind it — every decision in it
/// that is arithmetic rather than a view.
///
/// The Swift half of `apps/dashboard/src/components/chat/hold-core.ts`. Both are
/// run over one table by `tools/hold-fixture.sh`, so a disagreement here is
/// always between two implementations and never between an implementation and
/// someone's reading of the web's JSX.
///
/// Foundation only, on purpose: the fixture builds this file on the Mac in about
/// three seconds, with no simulator, no key and no network.
///
/// ## Why so much of a gesture is arithmetic
///
/// Almost none of what decides a press-and-hold is "what the finger did". It is
/// five thresholds, two rectangles and a circle 1240 points across, and every
/// one of those numbers came off a WeChat screenshot rather than out of taste
/// (see `HoldToTalkView` for how they were measured). Numbers like that are
/// exactly what a port gets subtly wrong and no assertion notices.

// MARK: - What the gesture is deciding between

/// Where the finger is, and therefore what lifting it will do.
enum HoldZone: String, Equatable, Codable {
    /// Lift here and the words go out.
    case send
    /// Slid left: throw them away.
    case cancel
    /// Slid right: drop them into the composer to fix before sending.
    case edit
}

/// Which of the three things a live press is currently doing.
enum HoldPhase: String, Equatable, Codable {
    /// The mic is not authorized yet, so this press ASKS instead of recording —
    /// the grant has to be requested from the release, never from under a held
    /// finger (an alert raised there swallows the touch and the release never
    /// arrives).
    case auth
    /// A run is live.
    case listening
    /// Released over send: the last words, and the whole-passage correction, are
    /// still landing.
    case finishing
}

// MARK: - The numbers

enum HoldMetrics {
    // ── thresholds ──────────────────────────────────────────────────────────

    /// Hold the empty box this long and the press has become "talking".
    static let holdMs: Double = 260
    static var holdDelay: TimeInterval { holdMs / 1000 }
    /// Travel this far before that and it was a scroll passing through.
    static let bailPx: CGFloat = 10
    /// Slide this far sideways, from where the finger went down, to pick 取消 / 编辑.
    static let slidePx: CGFloat = 64
    /// Below this the finger hasn't gone anywhere, so the pill hit-test stays off.
    static let pillMinPx: CGFloat = 24

    // ── the circle everything at the bottom is cut from ─────────────────────
    //
    // ONE circle, centred on the screen's vertical midline, `drop` points BELOW
    // the bottom edge. The send target is that circle filled in; 取消 and 编辑 are
    // a band around it, split at the top into two round-ended arcs. So the three
    // targets never touch and never overlap, and each curves the way a thumb
    // does when it swings across the bottom of a phone.
    //
    // Absolute points on purpose: the assembly is anchored to the bottom edge,
    // where the thumb is, and on a wider phone the arcs simply run further off
    // the sides — which is what WeChat does.

    /// How far below the bottom edge the shared centre sits.
    static let drop: CGFloat = 419
    /// The filled disc — "lift here and it sends".
    static let rDome: CGFloat = 540
    /// Outer edge of the 取消 / 编辑 band.
    static let rOut: CGFloat = 620
    /// Band thickness, so its inner edge is 558 — 18 points of dark between it
    /// and the dome.
    static let band: CGFloat = 62
    /// Each arc's round end, either side of the midline; the two leave a 31-point
    /// gap at the top.
    static let cap: CGFloat = 46.5
    /// The band's centreline radius.
    static var rMid: CGFloat { rOut - band / 2 }
    /// Tall enough to contain the band's highest point (~201).
    static let zoneH: CGFloat = 224
    /// Where each label sits along its arc, measured from the midline.
    static let labelD: CGFloat = 114
    /// How far above the bottom edge the dome's apex sits.
    static var domeApex: CGFloat { rDome - drop }

    /// Height above the bottom edge of the band's centreline, `d` points off the
    /// midline.
    static func midAt(_ d: CGFloat) -> CGFloat {
        (rMid * rMid - d * d).squareRoot() - drop
    }

    // ── the hit boxes ───────────────────────────────────────────────────────

    static let pillBottom: CGFloat = 100
    static let pillHeight: CGFloat = 105
    static let pillGutter: CGFloat = 15

    // ── coming and going ────────────────────────────────────────────────────
    //
    // Short on purpose. The enter arrives 260ms into a press that has not shown
    // anything yet, so any transition is delay stacked on delay. Enter is a
    // touch slower than leave so arriving reads as landing rather than snapping.

    static let enterMs: Double = 140
    static let leaveMs: Double = 120
    static var enter: TimeInterval { enterMs / 1000 }
    static var leave: TimeInterval { leaveMs / 1000 }
}

// MARK: - The gesture

/// A rectangle in window coordinates. Right and bottom are INCLUSIVE edges,
/// which is what the web's `>=` / `<=` hit test does and therefore what this
/// must do.
struct HoldRect: Equatable, Codable {
    var left: CGFloat
    var top: CGFloat
    var right: CGFloat
    var bottom: CGFloat

    func contains(x: CGFloat, y: CGFloat) -> Bool {
        x >= left && x <= right && y >= top && y <= bottom
    }
}

enum HoldCore {
    /// Has this press stopped being a press?
    ///
    /// Asked only BEFORE the hold fires: any real travel in the first 260ms means
    /// the finger was going somewhere else, and the gesture is handed back rather
    /// than starting to record.
    static func bailed(dx: CGFloat, dy: CGFloat) -> Bool {
        (dx * dx + dy * dy).squareRoot() > HoldMetrics.bailPx
    }

    /// Which exit the finger is currently over.
    ///
    /// Displacement decides, and landing ON a pill decides too, so a finger that
    /// aims at the target it can see is not second-guessed. The pill test is
    /// gated on having moved at all (`pillMinPx`), or a press that started near a
    /// corner would read as "cancel" before the finger did anything.
    ///
    /// Left wins ties — `dx <= -slidePx` is tested first — and a point inside
    /// both rectangles is impossible, since they are split either side of the
    /// midline.
    static func zone(dx: CGFloat, dy: CGFloat, x: CGFloat, y: CGFloat,
                     cancel: HoldRect?, edit: HoldRect?) -> HoldZone {
        let travelled = (dx * dx + dy * dy).squareRoot() > HoldMetrics.pillMinPx
        func onPill(_ r: HoldRect?) -> Bool {
            guard travelled, let r else { return false }
            return r.contains(x: x, y: y)
        }
        if dx <= -HoldMetrics.slidePx || onPill(cancel) { return .cancel }
        if dx >= HoldMetrics.slidePx || onPill(edit) { return .edit }
        return .send
    }

    /// The two hit boxes, in window coordinates, from the window's size.
    ///
    /// Deliberately plain rectangles over the two arcs: a slide that overshoots
    /// into the corner above one should land on it anyway.
    static func hitBoxes(width: CGFloat, height: CGFloat) -> (cancel: HoldRect, edit: HoldRect) {
        let top = height - HoldMetrics.pillBottom - HoldMetrics.pillHeight
        let bottom = height - HoldMetrics.pillBottom
        return (
            cancel: HoldRect(left: 0, top: top,
                             right: width / 2 - HoldMetrics.pillGutter, bottom: bottom),
            edit: HoldRect(left: width / 2 + HoldMetrics.pillGutter, top: top,
                           right: width, bottom: bottom)
        )
    }

    // MARK: - What the overlay says

    /// The label on the lit surface under the thumb. WeChat's dome is blank — its
    /// users have held that button for a decade; ours have not, so the surface
    /// says what lifting will do.
    static func surfaceLabel(_ phase: HoldPhase) -> String {
        phase == .finishing ? "正在发送" : "松开发送"
    }

    static let cancelLabel = "取消"
    static let editLabel = "编辑"
    static let authLabel = "需要麦克风权限才能说话"
    static let authHint = "松手 · 允许使用麦克风"

    /// Is the transcript being shown as "about to be thrown away"? Only while the
    /// run is still live — once the finger has lifted over 取消 there is nothing
    /// left to strike through.
    static func cancelling(zone: HoldZone, phase: HoldPhase) -> Bool {
        zone == .cancel && phase == .listening
    }

    /// May the blob move? Held still while the finger is over 取消 — a blob still
    /// bouncing over the words you are about to throw away reports on nothing.
    /// 编辑 is still recording, so it keeps moving.
    static func blobMoving(open: Bool, zone: HoldZone, phase: HoldPhase) -> Bool {
        open && phase == .listening && zone != .cancel
    }

    /// The elapsed clock under the bubble: `m:ss`, minutes uncapped.
    static func clock(_ seconds: Double) -> String {
        let s = Int(max(0, seconds.rounded(.down)))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
}

// MARK: - The slot right of the box

/// What sits between the text field and the send circle.
///
/// `mic` while the box is empty (or while a run is live, however much has been
/// dictated into it) and `clear` once there is a draft — `none` only when there
/// is nothing to say.
///
/// The mic is a TOGGLE: the same pixels start the run and end it, and while it
/// is listening it is LIT rather than swapped for another glyph. That is why
/// `listening` is a flag on the same case rather than a case of its own.
enum MicSlot: Equatable {
    case none
    case clear
    /// - Parameters:
    ///   - listening: a run is live — rose, with a breathing halo.
    ///   - spinner: the permission ask is in flight, so the glyph is a spinner.
    ///   - disabled: …and the button refuses taps while it is.
    case mic(listening: Bool, spinner: Bool, disabled: Bool)
}

extension HoldCore {
    static func micSlot(dictating: Bool,
                        draftLength: Int,
                        canDictate: Bool,
                        disabled: Bool,
                        awaitingInput: Bool,
                        micArming: Bool) -> MicSlot {
        if (dictating || draftLength == 0) && canDictate && !disabled && !awaitingInput {
            return .mic(listening: dictating, spinner: micArming, disabled: micArming)
        }
        if draftLength > 0 && !disabled { return .clear }
        return .none
    }

    /// What the mic button announces to VoiceOver.
    static func micSlotLabel(dictating: Bool) -> String {
        dictating ? "结束听写" : "语音输入"
    }

    /// Should the transparent press layer be over the field right now?
    ///
    /// A long press on a real text field belongs to the platform — UIKit answers
    /// it with the magnifier and an edit menu — so the hold is taken by a plain
    /// view that has no such behaviour, and only while the box is EMPTY and
    /// UNFOCUSED. The moment there is text or a caret the layer is gone.
    ///
    /// `gestureLive` is a parameter rather than an `||` at the call site because
    /// once a run HAS started every other input changes immediately: the words
    /// land in the draft and `dictating` goes true. A layer that disappears under
    /// a held finger never delivers its move or its release — the zones would be
    /// dead and the run would never end.
    static func pressLayer(touch: Bool,
                           canDictate: Bool,
                           disabled: Bool,
                           awaitingInput: Bool,
                           dictating: Bool,
                           draftLength: Int,
                           focused: Bool,
                           gestureLive: Bool) -> Bool {
        let idle = touch && canDictate && !disabled && !awaitingInput
            && !dictating && draftLength == 0 && !focused
        return idle || gestureLive
    }
}
