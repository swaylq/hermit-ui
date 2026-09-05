import SwiftUI

/// The CSS this app keeps needing and SwiftUI has no word for: two box
/// questions, as `Layout`s, and Tailwind's `animate-pulse`.
///
/// The two layouts were written for the attachment chip in round 8 and are used
/// by the hold-to-talk bubble in round 9, which is what moved them here: each
/// one is a CSS primitive, not a piece of either view. The pulse was written
/// inline in `StatusDot` in round 1 and got its second caller — the lit
/// microphone — in round 9.
///
/// Foundation-and-SwiftUI only, so the render tools can compile them alone.

// MARK: - the still-frame knob

/// "This is being drawn into a PNG, not onto a screen."
///
/// `accessibilityReduceMotion` is read-only in the environment, so the still-frame
/// renderers cannot borrow it; this is the knob they set instead.
/// `tools/render-list.swift` turns it on, and without it ImageRenderer catches the
/// pulse animation at its dim end — every pulsing dot lands at half strength and
/// `tools/pixel-compare.sh` reports four wrong dots when nothing is wrong. The web
/// harness kills `animate-pulse` with a CSS rule for exactly the same reason.
private struct StillFrameKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    var hermitStillFrame: Bool {
        get { self[StillFrameKey.self] }
        set { self[StillFrameKey.self] = newValue }
    }
}

// MARK: - the web's line box

/// Give a block of text the height CSS would give it: one `line` per line the
/// text actually wrapped onto, with the text centred in that box the way a CSS
/// line box centres its content (half-leading above, half below).
///
/// SwiftUI's `lineSpacing` sets the gap BETWEEN lines and nothing else, so a
/// block of n lines comes out `n·natural + (n−1)·spacing` — short of `n·line` by
/// one line's worth of leading, every time, no matter what the constant says.
/// Padding it by a constant works only while the assumed natural height is
/// right; this counts instead:
///
///     one  = the height at unlimited width        → one natural line
///     all  = the height at the width it is getting → n·natural + (n−1)·spacing
///     n    = (all − one) / (one + spacing) + 1
///
/// which is exact for any font metrics at all, and is why a wrong `natural`
/// costs a point of pitch inside the block rather than a point of drift that
/// accumulates down the screen. `TimelineMetrics` has the same open question
/// (docs/ios-native-progress.md, M6's first blocker) and this is the answer to
/// it — the timeline can adopt it whole.
struct WebLineBox: Layout {
    /// The web's line box: `font-size × line-height`.
    var line: CGFloat
    /// The `lineSpacing` the child already carries. Passed rather than applied
    /// so the arithmetic can use it.
    var spacing: CGFloat

    private func measure(_ child: LayoutSubview, width: CGFloat) -> (lines: Int, height: CGFloat) {
        let one = child.sizeThatFits(ProposedViewSize(width: .infinity, height: nil)).height
        let all = child.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        let pitch = one + spacing
        guard pitch > 0 else { return (1, line) }
        let n = max(1, Int(((all - one) / pitch).rounded()) + 1)
        return (n, CGFloat(n) * line)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let width = proposal.width ?? child.sizeThatFits(.unspecified).width
        return CGSize(width: width, height: measure(child, width: width).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        child.place(at: CGPoint(x: bounds.midX, y: bounds.midY), anchor: .center,
                    proposal: ProposedViewSize(width: bounds.width, height: nil))
    }
}

// MARK: - max-width

/// CSS `max-width` for one child: it gets its own ideal width when that fits
/// under the cap and exactly the cap when it does not — and is then asked how
/// tall it is AT that width, which is what lets wrapped text grow the box.
///
/// SwiftUI has no modifier that does this. `.frame(maxWidth:)` is a FLEXIBLE
/// frame: it takes everything on offer and only falls back to the ideal when the
/// proposal is nil, and even then it sizes ITSELF without re-asking the child
/// how tall it is at the clamped width. Both halves of that mattered here — see
/// the note in the chip.
struct MaxWidthBox: Layout {
    var maxWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let ideal = child.sizeThatFits(.unspecified)
        let width = min(ideal.width, maxWidth)
        let height = child.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        child.place(at: CGPoint(x: bounds.minX, y: bounds.minY), anchor: .topLeading,
                    proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}


// MARK: - animate-pulse

/// Tailwind's `animate-pulse`: opacity 1 → 0.5 → 1 over two seconds, forever.
///
/// Reduce Motion turns it off and leaves the view at FULL strength, and a still
/// frame never starts it. Neither is what the web does — Tailwind's keyframes
/// run whatever `prefers-reduced-motion` says — and both are deliberate: a thing
/// that breathes forever is what the setting exists to stop, and a screenshot of
/// a pulse caught mid-cycle is a screenshot of a random opacity (round 1 lost an
/// afternoon to every pulsing dot landing at half strength in the render, which
/// is why `render-web-*.sh` kills the animation on the web side too).
struct HermitPulse: ViewModifier {
    /// False leaves the view alone entirely — the caller's own gate.
    var active: Bool = true

    @State private var dim = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.hermitStillFrame) private var stillFrame

    private var runs: Bool { active && !reduceMotion && !stillFrame }

    func body(content: Content) -> some View {
        content
            .opacity(runs && dim ? 0.5 : 1)
            .animation(runs ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : .default,
                       value: dim)
            .onAppear { if runs { dim = true } }
            .onChange(of: runs) { _, on in dim = on }
    }
}
