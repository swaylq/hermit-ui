import SwiftUI

/// The waiting-dispatch strip, drawn to match `QueueBar` in
/// `components/chat/composer.tsx`.
///
/// It sits between the conversation and the composer and it is the only place a
/// message that has been sent but not yet started is visible — and therefore
/// the only chance to take one back. Everything it decides comes out of
/// `QueueCore`; this file is geometry and colour.
///
/// Pure SwiftUI for the same reason `ComposerView` is: `tools/render-composer.sh`
/// draws it on the Mac in two seconds, and round 5 is why that is worth having.
enum QueueBarMetrics {
    /// `px-3` on the column that holds the card — the composer's own `padH`, so
    /// the two line up. The web's `max-w-3xl` is centred and never binds on a
    /// phone.
    static let padH: CGFloat = 12
    /// `mb-2`-ish: the gap between the card and the composer under it. The web
    /// has none of its own — the composer's `pt-1` is the whole gap.
    static let gapBelow: CGFloat = 0

    /// `rounded-lg` — `--radius`, 0.625rem.
    static let radius: CGFloat = 10
    /// `px-3 py-2` inside the card.
    static let cardPadH: CGFloat = 12
    static let cardPadV: CGFloat = 8
    static let hairline: CGFloat = 1

    /// `text-xs`: 0.75rem over a 1rem line box.
    static let font: CGFloat = 12
    static let line: CGFloat = 16

    /// `mb-1` under the summary row, `gap-1` between queued lines, `gap-2`
    /// between the pieces of one line.
    static let headerGap: CGFloat = 4
    static let rowGap: CGFloat = 4
    static let itemGap: CGFloat = 8

    /// `px-1.5 py-0.5` on the clear button, `rounded`.
    static let clearPadH: CGFloat = 6
    static let clearPadV: CGFloat = 2
    static let buttonRadius: CGFloat = 4

    /// `h-3.5 w-3.5` on the ✕, `p-0.5` around it, so an 18pt button.
    static let closeIcon: CGFloat = 14
    static let closePad: CGFloat = 2
    /// lucide draws on a 24 viewBox with `stroke-width: 2`, so at 14pt the
    /// stroke is 2/24 of that. An SF Symbol `xmark` at any weight is a
    /// noticeably heavier mark — see `LucideX`.
    static let closeStroke: CGFloat = 14 * 2 / 24

    /// How far the ✕'s TAP area reaches past what it draws.
    ///
    /// The web's is 18×18, which is a mouse target. A finger wants 44, and
    /// growing the control to 44 would move the prose column and stop this from
    /// matching the web. So the drawn size is the web's and the hit area is
    /// outset — horizontally by enough to matter, vertically by only as much as
    /// the gap allows, because two of these outsetting into each other would
    /// let a tap delete the neighbouring message.
    static let hitOutsetH: CGFloat = 5
    static let hitOutsetV: CGFloat = 2
}

/// lucide-react's `X`, drawn rather than approximated.
///
/// The web's ✕ is an SVG on a 24 viewBox: two strokes from 6 to 18, round caps,
/// `stroke-width: 2`. So at `h-3.5` the visible cross is 7pt inside an 18pt
/// button and the stroke is 1.17pt. `Image(systemName: "xmark")` is a different
/// mark at every weight — bigger relative to its box and heavier — and the first
/// version of this file used it. Nothing in an assertion can see that; the
/// pixel comparison against the real component can.
///
/// Here rather than in a shared icon file because it is the first one. When a
/// second lucide glyph is needed they move together.
struct LucideX: Shape {
    func path(in rect: CGRect) -> Path {
        let inset = min(rect.width, rect.height) * 6 / 24
        let r = rect.insetBy(dx: inset, dy: inset)
        var p = Path()
        p.move(to: CGPoint(x: r.maxX, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
        return p
    }
}

/// One line in the strip: what to draw, and what a ✕ on it means.
struct QueueBarItem: Equatable, Identifiable {
    var id: String
    /// `QueueCore.itemLabel(...)` — already resolved, `（附件）` included.
    var label: String
}

struct QueueBarModel: Equatable {
    var items: [QueueBarItem] = []
    /// `clearQueue` is in the air: the button goes quiet so it cannot be
    /// pressed twice.
    var clearing = false

    var isEmpty: Bool { items.isEmpty }
}

struct QueueBarView: View {
    @Environment(\.colorScheme) private var scheme

    var model: QueueBarModel
    var onCancel: (String) -> Void
    var onClear: () -> Void

    private var muted: Color { WebContract.mutedForeground.resolve(scheme) }
    private var fg: Color { WebContract.foreground.resolve(scheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: QueueBarMetrics.headerGap) {
            header
            // `<ul className="flex flex-col gap-1">`
            VStack(alignment: .leading, spacing: QueueBarMetrics.rowGap) {
                ForEach(Array(model.items.enumerated()), id: \.element.id) { i, item in
                    line(index: i, item: item)
                }
            }
        }
        // `px-3 py-2` PLUS the border, for the reason ComposerView's row spells
        // out: CSS measures padding from INSIDE the border and `box-sizing:
        // border-box` adds the border to the element, so the web's card is
        // 1 + 8 + content + 8 + 1. SwiftUI's `.strokeBorder` is an overlay and
        // contributes nothing to the bounds. Chrome puts the one-line card at 60
        // points; without this it came out 58, and six of them stacked put the
        // whole comparison 12 points out of register.
        .padding(.horizontal, QueueBarMetrics.cardPadH + QueueBarMetrics.hairline)
        .padding(.vertical, QueueBarMetrics.cardPadV + QueueBarMetrics.hairline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: QueueBarMetrics.radius, style: .continuous)
                // `bg-muted/40` — muted is already a near-background grey, and
                // at 40% it is the faintest fill on the screen. Deliberately:
                // this strip is a receipt, not an alert.
                .fill(WebContract.muted.resolve(scheme).opacity(0.4))
        )
        .overlay(
            RoundedRectangle(cornerRadius: QueueBarMetrics.radius, style: .continuous)
                .strokeBorder(WebContract.border.resolve(scheme), lineWidth: QueueBarMetrics.hairline)
        )
        .padding(.horizontal, QueueBarMetrics.padH)
        .padding(.bottom, QueueBarMetrics.gapBelow)
    }

    /// `<div className="mb-1 flex items-center justify-between text-muted-foreground">`
    private var header: some View {
        HStack(spacing: QueueBarMetrics.itemGap) {
            Text(QueueCore.summary(model.items.count))
                .font(.system(size: QueueBarMetrics.font))
                .foregroundStyle(muted)
                .lineLimit(1)
                .frame(height: QueueBarMetrics.line, alignment: .leading)
            Spacer(minLength: 0)
            Button(action: onClear) {
                Text(QueueCore.clearLabel)
                    .font(.system(size: QueueBarMetrics.font))
                    .foregroundStyle(muted)
                    .lineLimit(1)
                    .frame(height: QueueBarMetrics.line)
                    .padding(.horizontal, QueueBarMetrics.clearPadH)
                    .padding(.vertical, QueueBarMetrics.clearPadV)
                    .contentShape(RoundedRectangle(cornerRadius: QueueBarMetrics.buttonRadius))
            }
            .buttonStyle(.plain)
            .disabled(model.clearing)
            // `disabled:opacity-40`
            .opacity(model.clearing ? 0.4 : 1)
            .accessibilityIdentifier("queue.clear")
            // No negative trailing padding here, though the first version had
            // one. Chrome puts this button's BOX flush with the content edge
            // (`justify-between` on a `px-3` row: 305…365 inside a 25…365 row),
            // so its `px-1.5` is inset, not overhang. Pulling it out by 6 moved
            // the label 6pt right of the web's — invisible beside a card edge,
            // plain in the pixel comparison.
        }
    }

    /// `<li className="flex items-center gap-2 min-w-0">`
    private func line(index: Int, item: QueueBarItem) -> some View {
        HStack(spacing: QueueBarMetrics.itemGap) {
            // `shrink-0 tabular-nums text-muted-foreground/60`
            Text("\(index + 1).")
                .font(.system(size: QueueBarMetrics.font).monospacedDigit())
                .foregroundStyle(muted.opacity(0.6))
                .fixedSize()
            // `min-w-0 flex-1 truncate text-foreground/80` — greedy on purpose
            // here, unlike the header's meta line: `flex-1` IS greedy, and this
            // is the column the ✕ has to be pushed to the far side of.
            Text(item.label)
                .font(.system(size: QueueBarMetrics.font))
                .foregroundStyle(fg.opacity(0.8))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button { onCancel(item.id) } label: {
                LucideX()
                    .stroke(muted, style: StrokeStyle(lineWidth: QueueBarMetrics.closeStroke,
                                                      lineCap: .round, lineJoin: .round))
                    .frame(width: QueueBarMetrics.closeIcon, height: QueueBarMetrics.closeIcon)
                    .padding(QueueBarMetrics.closePad)
                    // Grow the tap area without moving anything: pad, take the
                    // shape, then take the padding back off. See `hitOutsetH`.
                    .padding(.horizontal, QueueBarMetrics.hitOutsetH)
                    .padding(.vertical, QueueBarMetrics.hitOutsetV)
                    .contentShape(Rectangle())
                    .padding(.horizontal, -QueueBarMetrics.hitOutsetH)
                    .padding(.vertical, -QueueBarMetrics.hitOutsetV)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("cancel queued message")
            .accessibilityIdentifier("queue.cancel.\(index + 1)")
        }
        .frame(height: QueueBarMetrics.closeIcon + QueueBarMetrics.closePad * 2)
    }
}

/// The whole bottom of the chat screen: the queue strip, then the composer.
///
/// One hosting controller for the two, so the collection view's bottom anchor
/// has a single thing to sit on and the strip appearing pushes the conversation
/// up rather than covering it — which is what the web's flex column does.
///
/// The strip is DROPPED when it is empty rather than drawn at zero height. The
/// web keeps it mounted through a 200ms collapse so both directions animate;
/// here the animation is SwiftUI's, driven off the same emptiness.
struct ComposerStack: View {
    @Environment(\.colorScheme) private var scheme
    @ObservedObject var state: ComposerState

    var onSend: () -> Void
    var onStop: () -> Void
    var onClear: () -> Void
    var onDismissNotice: () -> Void
    var onDraftChange: (String) -> Void
    var onCancelQueued: (String) -> Void
    var onClearQueue: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if !state.queue.isEmpty {
                QueueBarView(model: state.queue, onCancel: onCancelQueued, onClear: onClearQueue)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            ComposerView(
                state: state,
                onSend: onSend, onStop: onStop, onClear: onClear,
                onDismissNotice: onDismissNotice, onDraftChange: onDraftChange
            )
        }
        .frame(maxWidth: .infinity)
        // Opaque, for the same reason the composer is: nothing scrolls under it.
        .background(WebContract.background.resolve(scheme))
        .animation(.easeOut(duration: 0.2), value: state.queue.isEmpty)
    }
}
