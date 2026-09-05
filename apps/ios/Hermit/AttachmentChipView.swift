import SwiftUI

/// The strip of attachment chips above the composer, drawn to match the
/// `AttachmentChip` / caps-caption block in `components/chat/composer.tsx`.
///
/// Pure SwiftUI, for the same reason `ComposerView` is: `tools/render-composer.sh`
/// draws it on the Mac in two seconds, and `tools/attach-compare.sh` puts that
/// picture beside the web's own `react-dom/server` render of the same fixture.
/// Nothing here decides anything — every string on screen comes out of
/// `AttachCore`, which is held against the web's functions by
/// `tools/attach-fixture.sh`.
enum AttachMetrics {
    /// `mb-2` under the whole block, `space-y-1.5` between the chips and the
    /// caption, `gap-2` between chips (both axes — a CSS flex `gap` is the row
    /// gap too, which is what a wrapped second line of chips lands on).
    static let stripBottom: CGFloat = 8
    static let blockGap: CGFloat = 6
    static let chipGap: CGFloat = 8

    /// `rounded-md border px-1.5 py-1`, `gap-2` inside.
    static let chipRadius: CGFloat = 6
    static let chipPadH: CGFloat = 6
    static let chipPadV: CGFloat = 4
    static let chipInnerGap: CGFloat = 8
    static let hairline: CGFloat = 1

    /// `h-10 w-10 rounded` on the thumbnail, `h-5 w-5` on the file glyph.
    static let thumb: CGFloat = 40
    static let thumbRadius: CGFloat = 4
    static let glyph: CGFloat = 20

    /// `text-[11px] font-mono` on the name, `text-[10px]` under it. NEITHER
    /// carries a line-height of its own — an arbitrary Tailwind font size does
    /// not set one — so both inherit the preflight `line-height: 1.5`, which is
    /// a RATIO and therefore 16.5 and 15 respectively.
    ///
    /// Round 17 learnt this the expensive way on the session row: the row's
    /// height was in a stylesheet nobody had opened, and eleven rows drifted
    /// four points apart each.
    static let nameFont: CGFloat = 11
    static let nameLine: CGFloat = 16.5
    static let subFont: CGFloat = 10
    static let subLine: CGFloat = 15
    /// The sub-label WRAPS. Only the name carries Tailwind's `truncate`; the
    /// line under it has no such class, so an error long enough — and they are,
    /// the server's 415 is three lines — grows the chip instead of being cut.
    /// A `.lineLimit(1)` here looked right in every single-line case and was
    /// wrong in exactly the two cases anyone would be reading it.
    ///
    /// Landing wrapped text on the web's 15pt line box takes two things, and
    /// the first version of this had only the first: `lineSpacing` sets the gap
    /// BETWEEN lines, and something has to make up the first and last line's own
    /// box. `WebLineBox` does the second by MEASURING — it counts the lines
    /// SwiftUI actually laid out and gives the block `lines × subLine` — so the
    /// total height is right whatever the font's own metrics turn out to be.
    ///
    /// `subNatural` is therefore only load-bearing for the PITCH between lines,
    /// not for the height of the block. 13.0 is what a 10-point monospaced
    /// system font measures here — NOT `size × 1.2`, which is the assumption
    /// `TimelineRowView` makes and which is worth 1 point per line: the first
    /// version of this file was 2 points over on a two-line error and 3 on a
    /// three-line one, and 20 points over eight cases was enough to put the
    /// whole comparison a row out of alignment by the bottom.
    static let subNatural: CGFloat = 13
    static let subLeading: CGFloat = subLine - subNatural
    /// `max-w-[120px]` on the text column. A CSS max-width is a CEILING; the
    /// element is still only as wide as its content. See the note on
    /// `.fixedSize` below for what makes SwiftUI agree.
    static let textMaxWidth: CGFloat = 120

    /// The `×`: `px-1 text-xs`, which in Tailwind is 12px over a 16px line box
    /// (`text-xs` sets both, unlike the arbitrary sizes above).
    static let removeFont: CGFloat = 12
    static let removeLine: CGFloat = 16
    static let removePadH: CGFloat = 4

    /// The caption: `px-0.5 text-[11px] tabular-nums`.
    static let capsFont: CGFloat = 11
    static let capsLine: CGFloat = 16.5
    static let capsPadH: CGFloat = 2

    /// `h-9 w-9` on the `+`, and the geometry of the lucide glyph inside it.
    ///
    /// Lucide draws `Plus` as `M5 12h14M12 5v14` in a 24-unit viewBox with
    /// `stroke-width: 2` and round caps, scaled here to `h-5 w-5`. So the arms
    /// are 14/24 of 20 points long and 2/24 of 20 thick — NOT a plus that fills
    /// the 20-point box, which is what an SF Symbol at `pointSize: 20` would
    /// draw. Two capsules reproduce it exactly and cost less than arguing with
    /// a symbol's optical sizing.
    static let plusArm: CGFloat = 20 * 14 / 24
    static let plusStroke: CGFloat = 20 * 2 / 24
    /// `pb-0.5` on the wrapper around the `+`.
    static let plusBottomPad: CGFloat = 2
}

/// One attachment, as the composer holds it.
///
/// The thumbnail is a SwiftUI `Image` rather than bytes so this file stays free
/// of UIKit: the phone builds it with `Image(uiImage:)`, the Mac renderer with
/// `Image(nsImage:)`, and neither is named here. `Image` is not `Equatable`, so
/// `previewToken` stands in for it — two chips with the same token show the same
/// picture, which is all the diffing needs to know.
struct ComposerAttachment: Identifiable, Equatable {
    var id: String
    var name: String
    var isImage: Bool
    var state: AttachCore.ChipState
    var previewToken: String?
    var preview: Image?

    static func == (a: ComposerAttachment, b: ComposerAttachment) -> Bool {
        a.id == b.id && a.name == b.name && a.isImage == b.isImage
            && a.state == b.state && a.previewToken == b.previewToken
    }

    /// The cap arithmetic's view of this chip.
    var slot: AttachCore.Slot {
        AttachCore.Slot(kind: kind, isImage: isImage)
    }

    var kind: AttachCore.Kind {
        switch state {
        case .uploading: return .uploading
        case .failed: return .error
        case .ready: return .ready
        }
    }

    /// `readyAttachments` — what `composerCanSend` counts and what a send
    /// actually carries.
    var isReady: Bool { kind == .ready }
}

// MARK: - The strip

/// `mb-2 space-y-1.5` holding `flex flex-wrap gap-2` of chips and the caption.
struct AttachmentStripView: View {
    @Environment(\.colorScheme) private var scheme
    var attachments: [ComposerAttachment]
    var onRemove: (String) -> Void

    private var caps: [AttachCore.CapSegment] {
        let live = AttachCore.occupiedSlots(attachments.map(\.slot))
        return AttachCore.capsCaption(images: live.images, files: live.files)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AttachMetrics.blockGap) {
            ChipFlow(spacing: AttachMetrics.chipGap) {
                ForEach(attachments) { a in
                    AttachmentChipView(attachment: a, onRemove: { onRemove(a.id) })
                }
            }
            if !caps.isEmpty {
                HStack(spacing: 0) {
                    ForEach(Array(caps.enumerated()), id: \.offset) { i, seg in
                        if i > 0 {
                            Text(AttachCore.capsSeparator)
                                .font(.system(size: AttachMetrics.capsFont, design: .monospaced))
                                .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.6))
                        }
                        Text(seg.text)
                            .font(.system(size: AttachMetrics.capsFont, design: .monospaced))
                            .monospacedDigit()
                            // `text-amber-600` once a cap is reached. It has no
                            // dark-scheme variant on the web either.
                            .foregroundStyle(seg.atCap
                                             ? (scheme == .dark ? WebContract.amber400 : AttachAmber.six)
                                             : WebContract.mutedForeground.resolve(scheme).opacity(0.6))
                    }
                }
                .frame(height: AttachMetrics.capsLine)
                .padding(.horizontal, AttachMetrics.capsPadH)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, AttachMetrics.stripBottom)
    }
}

/// `text-amber-600 dark:text-amber-400`, the caption's at-cap colour. Amber-400
/// is in `WebContract`; amber-600 is not (nothing else on a native screen draws
/// it) — the same bargain `ComposerAmber` takes next door, and it goes away the
/// moment a second screen needs the colour.
private enum AttachAmber {
    /// `amber-600` — oklch(66.6% 0.179 58.318)
    static let six = Color(.displayP3, red: 0.8452, green: 0.4713, blue: 0.0227)
}

// MARK: - One chip

struct AttachmentChipView: View {
    @Environment(\.colorScheme) private var scheme
    var attachment: ComposerAttachment
    var onRemove: () -> Void

    private var muted: Color { WebContract.mutedForeground.resolve(scheme) }

    /// `text-muted-foreground` while uploading, `text-emerald-600` once it has
    /// landed, `text-rose-500` when it failed. None of the three has a
    /// dark-scheme variant on the web.
    private var subColor: Color {
        switch attachment.state {
        case .uploading: return muted
        case .failed: return WebContract.rose500
        case .ready: return WebContract.emerald600
        }
    }

    var body: some View {
        HStack(spacing: AttachMetrics.chipInnerGap) {
            thumbnail
            MaxWidthBox(maxWidth: AttachMetrics.textMaxWidth) {
            VStack(alignment: .leading, spacing: 0) {
                Text(attachment.name)
                    .font(.system(size: AttachMetrics.nameFont, design: .monospaced))
                    .foregroundStyle(WebContract.foreground.resolve(scheme).opacity(0.8))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(height: AttachMetrics.nameLine, alignment: .leading)
                WebLineBox(line: AttachMetrics.subLine, spacing: AttachMetrics.subLeading) {
                    Text(AttachCore.chipSubLabel(attachment.state))
                        .font(.system(size: AttachMetrics.subFont, design: .monospaced))
                        .monospacedDigit()
                        .foregroundStyle(subColor)
                        .lineSpacing(AttachMetrics.subLeading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            }
            // `min-w-0 max-w-[120px]`. NOT `.frame(maxWidth:)`, which was the
            // first attempt and is wrong in both directions: a flexible frame is
            // greedy where CSS `max-width` only caps, and under a `.fixedSize`
            // that tames the greed the frame clamps its own box while the text
            // inside is still laid out at its single-line ideal — so a long
            // error drew OUTSIDE the chip, over the one below it, and the chip
            // stayed 50 points tall. `MaxWidthBox` asks the two questions CSS
            // asks: how wide would you like to be, and how tall are you at the
            // width you are actually getting.
            removeButton
        }
        // `px-1.5 py-1` PLUS the border: CSS measures padding inside the border
        // and `box-sizing: border-box` adds the border to the box, while
        // SwiftUI's `.strokeBorder` is an overlay that contributes nothing. The
        // queue strip lost two points per card to exactly this in round 7, and
        // the composer's own row lost two in round 6.
        .padding(.horizontal, AttachMetrics.chipPadH + AttachMetrics.hairline)
        .padding(.vertical, AttachMetrics.chipPadV + AttachMetrics.hairline)
        .background(
            RoundedRectangle(cornerRadius: AttachMetrics.chipRadius, style: .continuous)
                .fill(WebContract.background.resolve(scheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: AttachMetrics.chipRadius, style: .continuous)
                .strokeBorder(WebContract.border.resolve(scheme), lineWidth: AttachMetrics.hairline)
        )
        // No `.fixedSize` here: `ChipFlow` places every chip at the exact size it
        // asked for, so nothing above proposes a width this view has to defend
        // itself against.
    }

    /// `h-10 w-10 rounded object-cover` for an image, or the `bg-muted` plate
    /// with a document glyph for everything else.
    @ViewBuilder private var thumbnail: some View {
        if let preview = attachment.preview {
            preview
                .resizable()
                .scaledToFill()
                .frame(width: AttachMetrics.thumb, height: AttachMetrics.thumb)
                .clipShape(RoundedRectangle(cornerRadius: AttachMetrics.thumbRadius, style: .continuous))
                // `opacity-50` while it uploads, `opacity-30 grayscale` when it
                // failed — the picture stays, so you can see WHICH one failed.
                .grayscale(attachment.kind == .error ? 1 : 0)
                .opacity(attachment.kind == .uploading ? 0.5 : attachment.kind == .error ? 0.3 : 1)
                .accessibilityHidden(true)
        } else {
            RoundedRectangle(cornerRadius: AttachMetrics.thumbRadius, style: .continuous)
                .fill(WebContract.muted.resolve(scheme))
                .frame(width: AttachMetrics.thumb, height: AttachMetrics.thumb)
                .overlay(
                    Group {
                        if attachment.kind == .error {
                            Text("!")
                                .font(.system(size: AttachMetrics.nameFont, design: .monospaced))
                        } else {
                            // lucide `FileText`. SF Symbol `doc.text` is the
                            // nearest system glyph; it is not the same drawing,
                            // and that difference is the one deliberate one in
                            // this view.
                            Image(systemName: "doc.text")
                                .font(.system(size: AttachMetrics.glyph * 0.8))
                        }
                    }
                    .foregroundStyle(muted.opacity(0.7))
                )
        }
    }

    /// The literal `×` the web writes — a character, not an icon.
    private var removeButton: some View {
        Button(action: onRemove) {
            Text("×")
                .font(.system(size: AttachMetrics.removeFont, design: .monospaced))
                .foregroundStyle(WebContract.foreground.resolve(scheme).opacity(0.6))
                .frame(height: AttachMetrics.removeLine)
                .padding(.horizontal, AttachMetrics.removePadH)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("remove attachment")
        .accessibilityIdentifier("attach.remove")
    }
}

// The two CSS primitives this file used to define — `WebLineBox` (a block of
// text as tall as CSS would make it) and `MaxWidthBox` (a real `max-width`) —
// now live in `WebLayout.swift`. They were never about chips: the hold-to-talk
// bubble needs both, and a layout that answers a CSS question belongs beside the
// question rather than inside the first view that happened to ask it.

// MARK: - flex-wrap

/// `flex flex-wrap gap-2`: lay children out left to right, wrap when the next
/// one will not fit, and use the same gap between rows as between items.
///
/// A `Layout` rather than a hand-rolled `VStack` of `HStack`s because the wrap
/// has to happen at the width the composer actually gets, which nothing knows
/// until layout time.
struct ChipFlow: Layout {
    var spacing: CGFloat

    struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var out: [Row] = []
        var row = Row()
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            let advance = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            if !row.indices.isEmpty && advance > width {
                out.append(row)
                row = Row()
                row.indices = [i]
                row.width = size.width
                row.height = size.height
            } else {
                row.indices.append(i)
                row.width = advance
                row.height = max(row.height, size.height)
            }
        }
        if !row.indices.isEmpty { out.append(row) }
        return out
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        // `.infinity` for an unspecified proposal: a flex row that nobody has
        // constrained does not wrap. The composer always proposes a real width.
        let width = proposal.width ?? .infinity
        let laid = rows(subviews, width: width)
        let height = laid.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, laid.count - 1))
        let widest = laid.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = rows(subviews, width: bounds.width)
        var y = bounds.minY
        for row in laid {
            var x = bounds.minX
            for i in row.indices {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                                  proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }
}
