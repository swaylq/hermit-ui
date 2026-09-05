import SwiftUI

/// The press-and-hold voice overlay — WeChat's, drawn to match
/// `components/chat/hold-to-talk.tsx`.
///
/// Hold the "Ask anything" box and this takes the screen: the words appear in a
/// bubble as they are recognised, and where the finger is when it lifts decides
/// what happens to them —
///
///   lift where you are  → send it
///   slid LEFT  (取消)    → throw it away
///   slid RIGHT (编辑)    → drop it into the composer to fix before sending
///
/// ## The bottom of the screen is one circle
///
/// Everything down there is concentric, and it is worth knowing that before
/// reading a single number. There is ONE circle, centred on the screen's
/// vertical midline, 419 points BELOW the bottom edge. The send target is that
/// circle filled in. 取消 and 编辑 are a band around it, split at the top into two
/// round-ended arcs. So the three targets never touch and never overlap, and
/// each one curves the way a thumb does when it swings across the bottom of a
/// phone — which is the whole reason WeChat draws it this way.
///
/// The radii are in `HoldMetrics`, they were read off a WeChat screenshot rather
/// than chosen, and both this file and the web's are checked against them by
/// `tools/hold-fixture.sh`.
///
/// ## What is not copied
///
/// The colours. WeChat is green because WeChat is green; this app is greyscale
/// (every token in `globals.css` is `oklch(… 0 0)`) and its one accent for "the
/// mic is open" is the rose already on the composer's mic button. So: white
/// bubble, rose blob, grey surfaces. Only the geometry is borrowed.
///
/// ## And one thing that is not WeChat at all
///
/// The lit surface is labelled. WeChat's dome is blank — its users have held
/// that button for a decade. Ours have not, so the surface under the thumb says
/// 松开发送 while it is lit. It is the only thing telling a first-time user that
/// lifting is a choice rather than just letting go.
///
/// ## Pure SwiftUI
///
/// No UIKit, so `tools/render-hold.sh` draws all of it on the Mac in two seconds
/// and `tools/hold-compare.sh` puts it beside the web's own component. That
/// bargain is why the geometry above is worth stating at all: none of these
/// shapes can be checked by an assertion, and every one of them can be checked
/// by a picture.
///
/// Nothing here is interactive. The finger is still captured by the press layer
/// over the text field, so a button here could never receive its own tap; the
/// two hit boxes are `HoldCore.hitBoxes`, which the composer measures rather
/// than this view reporting.

// MARK: - What to draw

struct HoldToTalkModel: Equatable {
    var zone: HoldZone = .send
    var phase: HoldPhase = .listening
    /// The transcript so far — what will be sent.
    var text: String = ""
    /// Loudness, 0…1. Everything that reacts to the voice reads this one number.
    var level: Double = 0
    /// Seconds since the run started. Frozen once the finger lifts: the recording
    /// has stopped, and a clock still running through the send would be timing
    /// the wrong thing.
    var seconds: Double = 0
}

enum HoldToTalkMetrics {
    /// `bg-black/70` with a 3-point blur behind it.
    static let scrimOpacity: Double = 0.7
    static let scrimBlur: CGFloat = 3

    /// The stage: `gap-3 px-6 pb-[20vh]`.
    static let stageGap: CGFloat = 12
    static let stagePadH: CGFloat = 24
    static let stageBottomFraction: CGFloat = 0.20

    /// The bubble: `rounded-[20px] px-4 py-3`, `max-w-[min(30rem,84vw)]`.
    static let bubbleRadius: CGFloat = 20
    static let bubblePadH: CGFloat = 16
    static let bubblePadV: CGFloat = 12
    static let bubbleMaxWidth: CGFloat = 480
    static let bubbleMaxWidthFraction: CGFloat = 0.84
    /// `text-[15px] leading-relaxed` — 1.625, so a 24.375-point line box.
    static let bubbleFont: CGFloat = 15
    static let bubbleLine: CGFloat = 15 * 1.625
    /// The auth bubble inherits the root's size instead: 16 over `leading-normal`
    /// (1.5), a 24-point line box. Measured, not assumed — see
    /// `HERMIT_MEASURE=1 tools/render-web-hold.sh`.
    static let authFont: CGFloat = 16
    static let authLine: CGFloat = 24
    /// `-webkit-line-clamp: 8`.
    static let bubbleLines = 8
    /// The tail: a 14-point square turned 45°, 5 points below the bubble.
    static let tail: CGFloat = 14
    static let tailDrop: CGFloat = 5

    /// `box-shadow: 0 18px 50px -12px rgba(0,0,0,0.7)`.
    ///
    /// Three numbers and SwiftUI has one. `.shadow(radius:)` cannot express the
    /// SPREAD, and −12 is a third of the blur — dropping it puts a shadow 12
    /// points wider than the web's on every side. So the shadow is drawn by
    /// hand: the bubble's own shape, inset by the spread, offset, blurred.
    ///
    /// `shadowBlur` is CSS's 50 halved, because a CSS blur radius is two
    /// standard deviations and SwiftUI's `.blur(radius:)` is one. Verified by
    /// measurement, not by reading: the pair below is what makes
    /// tools/hold-compare.sh agree with Chrome's own falloff.
    static let shadowSpread: CGFloat = 12
    static let shadowOffsetY: CGFloat = 18
    static let shadowBlur: CGFloat = 25
    static let shadowOpacity: Double = 0.7

    /// The meter row: `text-[11px] gap-2`, a `h-1.5 w-1.5` dot, in a 16.5-point
    /// line box (11 × 1.5). The height has to be stated: SwiftUI sizes a line
    /// from the font's own metrics — about 13.1 points at size 11 — and three
    /// missing points here move every word above it.
    static let meterFont: CGFloat = 11
    static let meterLine: CGFloat = 11 * 1.5
    static let meterGap: CGFloat = 8
    static let meterDot: CGFloat = 6

    /// The blob before any words: a 42-point circle in a 120-point box.
    static let blobBox: CGFloat = 120
    static let blob: CGFloat = 42

    /// The dome's label: `text-[15px]` in a 22.5-point line box, 47 points below
    /// the apex.
    static let domeLabelFont: CGFloat = 15
    static let domeLabelLine: CGFloat = 15 * 1.5
    static let domeLabelDrop: CGFloat = 47
    /// The arcs' labels: `text-[16px] leading-5`, in a 120×20 box.
    static let arcLabelFont: CGFloat = 16
    static let arcLabelWidth: CGFloat = 120
    static let arcLabelHeight: CGFloat = 20

    /// `opacity: 0.85` lit, `0.13` not — and lit/unlit is an OPACITY change,
    /// never a colour one. Colour animates on the main thread and repaints the
    /// whole circle each frame; opacity is handed to the compositor, and these
    /// circles are 1080 and 1240 points across.
    static let domeLit: Double = 0.85
    static let domeDim: Double = 0.13
    static let arcLit: Double = 1
    static let arcDim: Double = 0.14

    /// The auth hint under the bubble: `text-[13px]`, a 19.5-point line box.
    static let authHintFont: CGFloat = 13
    static let authHintLine: CGFloat = 13 * 1.5
    /// The mic glyph in the auth bubble: `h-4 w-4`, `gap-2`.
    static let authIcon: CGFloat = 16
    static let authGap: CGFloat = 8
}

/// The one accent this app already uses for "the mic is open" — `rose-400`,
/// which is what `#fb7185` is.
private let rose = WebContract.rose400

struct HoldToTalkView: View {
    var model: HoldToTalkModel

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                Color.black.opacity(HoldToTalkMetrics.scrimOpacity)
                // A COLUMN, not a stack: the words sit above the targets rather
                // than over them, so the stage is only as tall as what is left.
                // Getting this wrong is invisible in the auth case — where there
                // ARE no targets and the stage is the whole screen — and 224
                // points out everywhere else.
                VStack(spacing: 0) {
                    stage(geo.size)
                    // During 授权 there is no choice to make — releasing anywhere
                    // opens the system alert — so drawing targets would be a lie.
                    if model.phase != .auth {
                        ZoneStack(zone: model.zone, phase: model.phase, width: geo.size.width)
                    }
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .ignoresSafeArea()
        // The finger belongs to the press layer over the composer for this whole
        // gesture; an overlay that swallowed touches could only steal them.
        .allowsHitTesting(false)
    }

    // MARK: - The words, where you can read them

    /// Up around the middle of the screen, nowhere near the thumb.
    private func stage(_ size: CGSize) -> some View {
        VStack(spacing: HoldToTalkMetrics.stageGap) {
            Spacer(minLength: 0)
            if model.phase != .auth {
                Meter(seconds: model.seconds, level: model.level, dimmed: cancelling)
            }
            if model.phase == .auth {
                Bubble(tint: Color.white.opacity(0.12), maxWidth: bubbleWidth(size)) {
                    HStack(spacing: HoldToTalkMetrics.authGap) {
                        Image(systemName: "mic")
                            .font(.system(size: HoldToTalkMetrics.authIcon * 0.8))
                            .frame(width: HoldToTalkMetrics.authIcon,
                                   height: HoldToTalkMetrics.authIcon)
                        Text(HoldCore.authLabel)
                            .font(.system(size: HoldToTalkMetrics.authFont))
                    }
                    .frame(height: HoldToTalkMetrics.authLine)
                    .foregroundStyle(Color.white.opacity(0.7))
                }
                Text(HoldCore.authHint)
                    .font(.system(size: HoldToTalkMetrics.authHintFont, weight: .medium))
                    .frame(height: HoldToTalkMetrics.authHintLine)
                    .foregroundStyle(Color.white.opacity(0.75))
            } else if !model.text.isEmpty {
                Bubble(tint: cancelling ? Color.white.opacity(0.14) : .white,
                       maxWidth: bubbleWidth(size)) {
                    // `-webkit-line-clamp: 8` clamps at the END, so the box shows
                    // the FIRST eight lines and an ellipsis — which is not what
                    // the comment beside it on the web claims, and is what the
                    // web actually draws. Ported as it ships; the disagreement
                    // between that comment and that CSS is written up in
                    // docs/ios-native-progress.md rather than fixed here.
                    WebLineBox(line: HoldToTalkMetrics.bubbleLine, spacing: bubbleLeading) {
                        Text(model.text)
                            .font(.system(size: HoldToTalkMetrics.bubbleFont))
                            .lineSpacing(bubbleLeading)
                            .lineLimit(HoldToTalkMetrics.bubbleLines)
                            .strikethrough(cancelling, color: Color.white.opacity(0.35))
                            .foregroundStyle(cancelling ? Color.white.opacity(0.45) : WebContract.neutral900)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            } else {
                VoiceBlob(level: model.level, dimmed: cancelling)
            }
        }
        .padding(.horizontal, HoldToTalkMetrics.stagePadH)
        // `pb-[20vh]` — twenty percent of the VIEWPORT, not of this box, which
        // is `flex-1` and therefore already 224 points shorter whenever the
        // targets are drawn.
        .padding(.bottom, size.height * HoldToTalkMetrics.stageBottomFraction)
        .frame(width: size.width,
               height: size.height - (model.phase == .auth ? 0 : HoldMetrics.zoneH),
               alignment: .bottom)
    }

    private var cancelling: Bool { HoldCore.cancelling(zone: model.zone, phase: model.phase) }

    /// The gap SwiftUI needs BETWEEN lines to land on the web's 24.375-point line
    /// box. `WebLineBox` around it is what supplies the missing half-leading at
    /// the top and bottom — see `WebLayout.swift`.
    private var bubbleLeading: CGFloat {
        max(0, HoldToTalkMetrics.bubbleLine - HoldToTalkMetrics.bubbleFont * 1.2)
    }

    private func bubbleWidth(_ size: CGSize) -> CGFloat {
        min(HoldToTalkMetrics.bubbleMaxWidth,
            size.width * HoldToTalkMetrics.bubbleMaxWidthFraction)
    }
}

// MARK: - The elapsed clock, and the dot that breathes with the voice

private struct Meter: View {
    var seconds: Double
    var level: Double
    var dimmed: Bool

    var body: some View {
        HStack(spacing: HoldToTalkMetrics.meterGap) {
            Circle()
                .fill(dimmed ? Color.white.opacity(0.35) : rose)
                .frame(width: HoldToTalkMetrics.meterDot, height: HoldToTalkMetrics.meterDot)
                .shadow(color: dimmed ? .clear : rose, radius: 4)
                .scaleEffect(1 + level * 0.9)
            Text(HoldCore.clock(seconds))
                .font(.system(size: HoldToTalkMetrics.meterFont, weight: .medium).monospacedDigit())
                .foregroundStyle(Color.white.opacity(0.6))
        }
        .frame(height: HoldToTalkMetrics.meterLine)
    }
}

// MARK: - A bubble with a tail pointing down at the finger

private struct Bubble<Content: View>: View {
    var tint: Color
    var maxWidth: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        // `MaxWidthBox` and not `.frame(maxWidth:)`: a flexible frame TAKES the
        // width on offer, and this bubble shrinks to its words. Round 8's chip
        // is where that difference was first paid for; see WebLayout.swift.
        MaxWidthBox(maxWidth: maxWidth) {
            content
                .padding(.horizontal, HoldToTalkMetrics.bubblePadH)
                .padding(.vertical, HoldToTalkMetrics.bubblePadV)
                .background(
                    RoundedRectangle(cornerRadius: HoldToTalkMetrics.bubbleRadius, style: .continuous)
                        .fill(tint)
                )
        }
        // `.compositingGroup()` and not `.shadow()`, and neither is decoration.
        // Grouping first because SwiftUI otherwise applies effects to every leaf
        // separately, so each glyph would cast its own shadow onto the white
        // bubble behind it — invisible on a dark screen and plain in the probe,
        // where the bubble's interior graded 253 → 245 downward toward the
        // words. CSS `box-shadow` is a property of the BOX.
        .compositingGroup()
        .background {
            // The shadow, drawn rather than asked for: `.shadow()` has no spread.
            RoundedRectangle(cornerRadius: HoldToTalkMetrics.bubbleRadius, style: .continuous)
                .fill(Color.black.opacity(HoldToTalkMetrics.shadowOpacity))
                .padding(HoldToTalkMetrics.shadowSpread)
                .offset(y: HoldToTalkMetrics.shadowOffsetY)
                .blur(radius: HoldToTalkMetrics.shadowBlur)
        }
        .overlay(alignment: .bottom) {
            // `bottom: -5px` on a 14-point square turned 45°: its centre lands
            // two points ABOVE the bubble's bottom edge, and the corner that
            // sticks out below is what points at the finger.
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(tint)
                .frame(width: HoldToTalkMetrics.tail, height: HoldToTalkMetrics.tail)
                .rotationEffect(.degrees(45))
                .offset(y: HoldToTalkMetrics.tailDrop)
        }
    }
}

// MARK: - The blob, before any words have arrived

private struct VoiceBlob: View {
    var level: Double
    var dimmed: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(dimmed ? Color.white.opacity(0.18) : rose)
                .frame(width: HoldToTalkMetrics.blob, height: HoldToTalkMetrics.blob)
                .shadow(color: dimmed ? .clear : rose.opacity(0.45), radius: 17)
                .scaleEffect(1 + level)
        }
        .frame(width: HoldToTalkMetrics.blobBox, height: HoldToTalkMetrics.blobBox)
    }
}

// MARK: - The three targets

/// The bottom of the screen: the send disc, the two arcs, and their labels.
///
/// It CLIPS. Without that the circles are bounded only by the screen and get
/// rasterised far larger than they show — 1080 and 1240 points across, at 3×.
private struct ZoneStack: View {
    var zone: HoldZone
    var phase: HoldPhase
    var width: CGFloat

    var body: some View {
        ZStack(alignment: .bottom) {
            // ── the send disc ──────────────────────────────────────────────
            Circle()
                .fill(.white)
                .frame(width: HoldMetrics.rDome * 2, height: HoldMetrics.rDome * 2)
                .offset(y: HoldMetrics.drop + HoldMetrics.rDome)
                .opacity(zone == .send ? HoldToTalkMetrics.domeLit : HoldToTalkMetrics.domeDim)

            HStack(spacing: 4) {
                if phase == .finishing {
                    // The send is out and the words are still settling.
                    Image(systemName: "circle.dotted")
                        .font(.system(size: 14, weight: .medium))
                }
                Text(HoldCore.surfaceLabel(phase))
                    .font(.system(size: HoldToTalkMetrics.domeLabelFont, weight: .medium))
            }
            // `text-transparent` when it is not lit: the label holds its place
            // rather than appearing, so nothing on the dome moves.
            .frame(height: HoldToTalkMetrics.domeLabelLine)
            .foregroundStyle(zone == .send ? WebContract.neutral800 : Color.clear)
            .offset(y: -(HoldMetrics.rDome - HoldMetrics.drop - HoldToTalkMetrics.domeLabelDrop))

            // ── the two arcs ───────────────────────────────────────────────
            Arc(side: .leading, active: HoldCore.cancelling(zone: zone, phase: phase),
                label: HoldCore.cancelLabel, width: width)
            Arc(side: .trailing, active: zone == .edit && phase == .listening,
                label: HoldCore.editLabel, width: width)
        }
        .frame(width: width, height: HoldMetrics.zoneH, alignment: .bottom)
        .clipped()
    }
}

/// One half of the band: a ring clipped to this side of the gap, plus a disc
/// closing the cut off with a round end. The union is a curved bar with one
/// rounded tip, which is not a shape SwiftUI has a name for.
private struct Arc: View {
    enum Side { case leading, trailing }
    var side: Side
    var active: Bool
    var label: String
    var width: CGFloat

    private var sign: CGFloat { side == .leading ? -1 : 1 }

    var body: some View {
        ZStack(alignment: .bottom) {
            // Ring and cap are both solid white and share ONE opacity. Tinting
            // them separately looks right until they meet: two 14% whites
            // overlapping composite to 26%, and the join shows up as a bright
            // disc sitting on the band. Fading the pair as a group composites once.
            //
            // Which is what `.compositingGroup()` below is for, and it is not
            // optional: SwiftUI's `.opacity()` on a container fades each child
            // SEPARATELY — the very thing the web's own comment says not to do.
            // Measured before the fix: 66 where the cap crosses the ring against
            // the web's 36, on exactly the half-disc the heat map lit up.
            ZStack(alignment: .bottom) {
                Circle()
                    .strokeBorder(.white, lineWidth: HoldMetrics.band)
                    .frame(width: HoldMetrics.rOut * 2, height: HoldMetrics.rOut * 2)
                    .offset(y: HoldMetrics.drop + HoldMetrics.rOut)
                    .frame(width: width, height: HoldMetrics.zoneH, alignment: .bottom)
                    .mask(alignment: side == .leading ? .leading : .trailing) {
                        Rectangle().frame(width: max(0, width / 2 - HoldMetrics.cap))
                    }
                Circle()
                    .fill(.white)
                    .frame(width: HoldMetrics.band, height: HoldMetrics.band)
                    .offset(x: sign * HoldMetrics.cap,
                            y: -(HoldMetrics.midAt(HoldMetrics.cap) - HoldMetrics.band / 2))
            }
            .compositingGroup()
            .opacity(active ? HoldToTalkMetrics.arcLit : HoldToTalkMetrics.arcDim)

            Text(label)
                .font(.system(size: HoldToTalkMetrics.arcLabelFont, weight: .medium))
                .frame(width: HoldToTalkMetrics.arcLabelWidth,
                       height: HoldToTalkMetrics.arcLabelHeight)
                .foregroundStyle(active ? WebContract.neutral900 : Color.white.opacity(0.7))
                .offset(x: sign * HoldMetrics.labelD,
                        y: -(HoldMetrics.midAt(HoldMetrics.labelD) - HoldToTalkMetrics.arcLabelHeight / 2))
        }
        .frame(width: width, height: HoldMetrics.zoneH, alignment: .bottom)
    }
}
