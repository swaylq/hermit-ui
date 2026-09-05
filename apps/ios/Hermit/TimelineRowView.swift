import SwiftUI

/// One row of the chat timeline, drawn the way `components/chat/message-timeline.tsx`
/// and `components/chat/run-capsule.tsx` draw it.
///
/// The input is a `FoldedRow` — the output of `FoldRuns.fold`, which is the
/// port of the web's own fold. So the two sides do not merely look alike: they
/// are told the same thing about what this conversation is made of, and a
/// disagreement about which blocks became a capsule is a fixture failure in
/// `tools/fold-fixture.sh` rather than a difference somebody has to spot in a
/// screenshot.
///
/// ## What this is not, yet
///
/// The skeleton of M4, deliberately: prose is drawn as PLAIN TEXT, and a run
/// capsule only ever draws its collapsed line. Markdown is the step that ends
/// this app's zero-third-party-dependency streak (`docs/ios-native-progress.md`
/// says why that is sway's call, not this file's), and expanding a capsule
/// needs the digest fetch that has no caller yet. Both slot in without moving
/// anything here: one swaps the renderer inside `ProseText`, the other adds a
/// body under `RunCapsuleView`'s summary line.
///
/// ## SwiftUI, no UIKit
///
/// Same discipline as `SessionRowView`, for the same reason: it lets
/// `tools/render-timeline.sh` compile these views for the Mac and write them to
/// a PNG in a few seconds, with no simulator, no signing and no server. A
/// layout you have to install to LOOK at is a layout nobody looks at.
struct TimelineRowView: View {
    let row: FoldedRow
    /// The width this row has to lay out in, in points, insets already taken
    /// off. Passed in rather than measured because `max-w-[85%]` is a fraction
    /// of the COLUMN and SwiftUI has no way to say "at most 85% of my parent"
    /// — `containerRelativeFrame` fixes the width instead of capping it, and a
    /// `GeometryReader` does not size itself to its content's height, which is
    /// the one thing a self-sizing list cell needs. The collection view knows
    /// this number and so does the still-frame renderer.
    let width: CGFloat
    /// Frozen for a screenshot. The app passes the real clock.
    var now: Date = Date()

    var body: some View {
        switch row {
        case .msg(let m): MessageRowView(message: m, width: width, now: now)
        case .run(let r): RunRowView(run: r, width: width)
        case .end(let e): TerminatorRowView(createdAt: e.createdAt, now: now)
        }
    }
}

// MARK: - The web's numbers

/// Every measurement on this screen, as the CSS pixels the Tailwind class in
/// `message-timeline.tsx` resolves to. `gap-3` is 12, `px-3` is 12, `py-2` is 8,
/// `rounded-md` is 6.
///
/// The two line heights are the ones that are not a class at all. `text-sm`
/// carries Tailwind v4's paired `--text-sm--line-height`, which is
/// `calc(1.25 / 0.875)` of 14px — 20px, not the 21 that "1.5 line-height" would
/// give. Everything set with a bracket size (`text-[10px]`, `text-[11px]`) sets
/// only the font size and inherits preflight's `line-height: 1.5` from `<html>`,
/// exactly as the session row does; that is the trap `RowMetrics` documents and
/// `tools/pixel-compare.sh` caught the hard way.
enum TimelineMetrics {
    /// `gap-3` on the column that holds the rows.
    static let rowGap: CGFloat = 12
    /// `max-w-[85%]` — a bubble, and a run capsule.
    static let maxWidthFraction: CGFloat = 0.85
    /// `max-w-[92%]` — a long system notice.
    static let systemWidthFraction: CGFloat = 0.92

    /// `text-sm`: 14px over a 20px line box.
    static let bodyFont: CGFloat = 14
    static let bodyLine: CGFloat = 20
    /// `text-[11px]` and `text-[10px]`, both over preflight's 1.5.
    static let capsuleFont: CGFloat = 11
    static let capsuleLine: CGFloat = 16.5
    static let metaFont: CGFloat = 10
    static let metaLine: CGFloat = 15
    /// `text-xs` — 12px over `calc(1 / 0.75)`, i.e. 16.
    static let noticeFont: CGFloat = 12
    static let noticeLine: CGFloat = 16

    /// `px-3 py-2` on a bubble, `rounded-md`.
    static let bubblePadH: CGFloat = 12
    static let bubblePadV: CGFloat = 8
    static let radius: CGFloat = 6
    /// `space-y-2` between the pieces inside a bubble, `pt-0.5` above its clock.
    static let bubbleStack: CGFloat = 8
    static let clockPadTop: CGFloat = 2

    /// `px-2.5 py-1.5` on the capsule's summary line, `gap-2` inside it.
    static let capsulePadH: CGFloat = 10
    static let capsulePadV: CGFloat = 6
    static let capsuleGap: CGFloat = 8
    /// `rounded border …` on the thinking-only chip: `px-2 py-0.5`, radius 4.
    static let chipPadH: CGFloat = 8
    static let chipPadV: CGFloat = 2
    static let chipRadius: CGFloat = 4

    /// A CSS `1px` hairline. Not `1 / displayScale`: the web draws one CSS
    /// pixel and so does this.
    static let hairline: CGFloat = 1

    /// `pb-3` under the "load earlier" pill — the gap between it and the oldest
    /// message. Hosts subtract whatever spacing they already put between rows.
    static let earlierGap: CGFloat = 12
    /// `px-3 py-1` on the pill itself.
    static let pillPadH: CGFloat = 12
    static let pillPadV: CGFloat = 4
}

/// `SwiftUI` sizes a line from the font's own metrics; CSS sizes it from the
/// `line-height` on the element. `.lineSpacing` is the difference, applied
/// between lines — which is what makes a wrapped paragraph land on the web's
/// leading instead of the system font's.
private extension View {
    func webLine(font: CGFloat, box: CGFloat) -> some View {
        // The system font's default line height is very close to 1.2 × size at
        // these sizes; the exact figure is not available without UIKit, and
        // being a fraction of a point out on the FIRST line of a paragraph is
        // not what a reader sees. What they see is the gap between lines.
        self.lineSpacing(max(0, box - font * 1.2))
    }
}

// MARK: - Who is speaking

/// `message-timeline.tsx`'s four-way classification, verbatim, including the
/// order the tests are written in.
///
/// It is a port and not a judgement of its own: `authoredBy` is a short string
/// four different producers write, and deciding here that "system" means
/// something slightly different from what the web decided is exactly the drift
/// `WebContract` exists to stop — only in prose instead of in colour.
enum SpeakerKind: Equatable {
    /// A person typed it. The one row that wears a solid bubble.
    case human
    /// Brain speaking in the user's slot: sender side, outlined, labelled.
    case brain
    /// A machine poke in the user's slot, or a real `system` row. A notice.
    case system
    /// A scheduled run reporting in: an assistant row that carries a label.
    case cron
    case assistant

    init(role: String, authoredBy: String?) {
        let byBrain = role == "user" && authoredBy == "brain"
        let byMachine = role == "user" && authoredBy == "system"
        if role == "system" || byMachine { self = .system; return }
        if byBrain { self = .brain; return }
        if role == "user" { self = .human; return }
        if role == "assistant" && authoredBy == "cron" { self = .cron; return }
        self = .assistant
    }

    /// `onSenderSide` — the right-hand column, which reads as "things said to
    /// this agent".
    var onSenderSide: Bool { self == .human || self == .brain }

    /// The standing label above the text, if this speaker gets one.
    var badge: (glyph: String, word: String)? {
        switch self {
        case .brain: return ("🦀", "Brain")
        case .cron: return ("⏰", "Scheduled")
        default: return nil
        }
    }
}

// MARK: - A message

private struct MessageRowView: View {
    let message: FoldedMessage
    let width: CGFloat
    let now: Date

    @Environment(\.colorScheme) private var scheme

    private var speaker: SpeakerKind {
        SpeakerKind(role: message.role, authoredBy: message.authoredBy)
    }

    var body: some View {
        if speaker == .system {
            SystemNoticeView(message: message, width: width)
        } else {
            HStack(spacing: 0) {
                if speaker.onSenderSide { Spacer(minLength: 0) }
                bubble.frame(maxWidth: width * TimelineMetrics.maxWidthFraction,
                             alignment: speaker.onSenderSide ? .trailing : .leading)
                if !speaker.onSenderSide { Spacer(minLength: 0) }
            }
            .frame(width: width, alignment: speaker.onSenderSide ? .trailing : .leading)
        }
    }

    private var bubble: some View {
        // ALWAYS leading, even in a bubble that sits on the right. The web's
        // bubble is a block container: its badge, its paragraphs and its chips
        // all start at the left edge whichever side the bubble is on, and only
        // the clock row carries `justify-end`. Aligning the whole stack to the
        // trailing edge put the Brain label and a file chip against the right
        // edge of the bubble, which no bubble on the page does.
        VStack(alignment: .leading, spacing: TimelineMetrics.bubbleStack) {
            if let badge = speaker.badge {
                HStack(spacing: 4) {                     // gap-1
                    Text(badge.glyph)
                    Text(badge.word).textCase(.uppercase).tracking(0.4)   // tracking-wide
                }
                .font(.system(size: TimelineMetrics.metaFont, weight: .medium))
                .foregroundStyle(WebContract.mutedForeground.resolve(scheme))
            }
            ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block, onDark: speaker == .human)
            }
            // `pt-0.5` and then the clock, on the side the bubble is on.
            Text(WebFormat.relTime(FoldRuns.parseDate(message.createdAt), now: now))
                .font(.system(size: TimelineMetrics.metaFont, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(clockColor)
                .padding(.top, TimelineMetrics.clockPadTop)
                // `justify-end` on the sender side, `justify-start` otherwise —
                // the one row in the bubble that does flip.
                .frame(maxWidth: .infinity,
                       alignment: speaker.onSenderSide ? .trailing : .leading)
        }
        .font(.system(size: TimelineMetrics.bodyFont))
        .padding(.horizontal, hasBox ? TimelineMetrics.bubblePadH : 0)
        .padding(.vertical, hasBox ? TimelineMetrics.bubblePadV : 0)
        .background(bubbleFill, in: RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular))
        .overlay {
            // Brain's outline is DASHED — `border-dashed border-foreground/30`.
            if speaker == .brain {
                RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular)
                    .strokeBorder(
                        WebContract.foreground.resolve(scheme).opacity(0.3),
                        style: StrokeStyle(lineWidth: TimelineMetrics.hairline, dash: [3, 3])
                    )
            }
        }
    }

    /// Only the sender side gets a box at all. An assistant reply is bare text
    /// on the page background — the web gives it no background, no padding and
    /// no border, and drawing one here would be the single most visible way
    /// this screen could stop looking like the dashboard.
    private var hasBox: Bool { speaker == .human || speaker == .brain }

    private var bubbleFill: Color {
        switch speaker {
        case .human: return WebContract.foreground.resolve(scheme)
        case .brain: return WebContract.muted.resolve(scheme).opacity(0.4)
        default: return .clear
        }
    }

    private var clockColor: Color {
        speaker == .human
            ? WebContract.background.resolve(scheme).opacity(0.6)
            : WebContract.mutedForeground.resolve(scheme).opacity(0.6)
    }
}

/// `[session restarted]` and the gateway's other pokes: centred, hairline, and
/// never conversation. Short ones are a pill, long ones a card — the web splits
/// on the same two conditions.
private struct SystemNoticeView: View {
    let message: FoldedMessage
    let width: CGFloat

    @Environment(\.colorScheme) private var scheme

    private var text: String { message.blocks.map(\.text).joined() }
    private var isLong: Bool { text.contains("\n") || text.count > 100 }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            content.frame(maxWidth: width * TimelineMetrics.systemWidthFraction)
            Spacer(minLength: 0)
        }
        .frame(width: width)
    }

    @ViewBuilder private var content: some View {
        if isLong {
            Text(text)
                .font(.system(size: TimelineMetrics.noticeFont))
                .webLine(font: TimelineMetrics.noticeFont, box: TimelineMetrics.noticeLine)
                .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.9))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)               // px-3
                .padding(.vertical, 8)                  // py-2
                .background(WebContract.muted.resolve(scheme).opacity(0.4),
                            in: RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular))
                .overlay {
                    RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular)
                        .strokeBorder(WebContract.border.resolve(scheme), lineWidth: TimelineMetrics.hairline)
                }
        } else {
            Text(text)
                .font(.system(size: TimelineMetrics.capsuleFont, design: .monospaced))
                .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.8))
                .padding(.horizontal, 12)               // px-3
                .padding(.vertical, 4)                  // py-1
                .background(WebContract.muted.resolve(scheme).opacity(0.4), in: Capsule())
                .overlay { Capsule().strokeBorder(WebContract.border.resolve(scheme), lineWidth: TimelineMetrics.hairline) }
        }
    }
}

// MARK: - One block inside a message

/// A folded message's blocks are machinery-free — `FoldRuns` lifted the tool
/// calls, results and thinking into the runs on either side — so what reaches
/// here is prose, media, an interaction, the one tool call that IS a question,
/// and whatever this build has never heard of.
///
/// Every branch draws SOMETHING. That is the discipline `SessionCard.swift`
/// states and the reason `ContentBlock.parse` cannot fail: a block type added
/// on the web next month has to look unfamiliar on the phone, not invisible.
private struct BlockView: View {
    let block: ContentBlock
    /// Sitting on the solid `bg-foreground` bubble, where the muted colours
    /// would be unreadable.
    var onDark: Bool = false

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch block {
        case .text(let b):
            ProseText(text: b.text, onDark: onDark)
        case .thinking(let b):
            // Only reachable for a message whose thinking block the fold left
            // in place (a zero-length one is dropped by `FoldRuns.step`).
            ThinkingChip(chars: b.chars)
        case .toolUse(let b):
            // The ask tool call: `isAskToolUse` keeps it out of the capsule
            // precisely so the question stays where a person can see it.
            PlaceholderCard(
                label: b.input.string("question") == nil ? b.name : "ask",
                detail: b.input.string("question") ?? ""
            )
        case .toolResult:
            PlaceholderCard(label: "tool result", detail: "")
        case .image(let b):
            MediaChip(glyph: "photo", label: b.source.url ?? b.name ?? "image", onDark: onDark)
        case .file(let b):
            MediaChip(glyph: "doc", label: b.name ?? b.source.url ?? "file", onDark: onDark)
        case .interaction(let b):
            PlaceholderCard(
                label: b.kind == .permission ? "permission" : "question",
                detail: b.payload.string("question") ?? b.payload.string("tool") ?? ""
            )
        case .unknown(let type, _):
            // The grey card, naming the type its producer gave it. An empty
            // `type` is a block that was not even an object; say that rather
            // than draw an unlabelled box.
            PlaceholderCard(label: type.isEmpty ? "unrecognised block" : type, detail: "")
        }
    }
}

/// A paragraph. Plain text today — see the note at the top of this file about
/// what replaces this and when.
private struct ProseText: View {
    let text: String
    var onDark: Bool

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(text)
            .webLine(font: TimelineMetrics.bodyFont, box: TimelineMetrics.bodyLine)
            .foregroundStyle(
                onDark
                    ? WebContract.background.resolve(scheme)
                    : WebContract.foreground.resolve(scheme).opacity(0.9)   // text-foreground/90
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The bordered card every block this screen cannot draw properly falls back
/// to. It always says what the block was.
private struct PlaceholderCard: View {
    let label: String
    let detail: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: TimelineMetrics.capsuleFont, design: .monospaced))
                .foregroundStyle(WebContract.mutedForeground.resolve(scheme))
            if !detail.isEmpty {
                Text(detail)
                    .font(.system(size: TimelineMetrics.noticeFont))
                    .webLine(font: TimelineMetrics.noticeFont, box: TimelineMetrics.noticeLine)
                    .foregroundStyle(WebContract.foreground.resolve(scheme).opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(WebContract.muted.resolve(scheme).opacity(0.4),
                    in: RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular))
        .overlay {
            RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular)
                .strokeBorder(WebContract.border.resolve(scheme), lineWidth: TimelineMetrics.hairline)
        }
    }
}

/// A stand-in for an image or a file: a one-line chip naming it.
///
/// NOT a port of `components/chat/file-preview.tsx` — that draws the actual
/// thumbnail and opens a lightbox, and it is M4's own image/file item. What
/// this guarantees until then is only the discipline every branch here follows:
/// a block the screen cannot draw properly still says what it was, instead of
/// leaving a hole.
private struct MediaChip: View {
    let glyph: String
    let label: String
    /// On the solid `bg-foreground` bubble, where `--muted-foreground` and
    /// `--border` are both a near-invisible grey on a near-black fill. The
    /// bubble's own text colour is `--background`; everything on it is a
    /// fraction of that.
    var onDark: Bool = false

    @Environment(\.colorScheme) private var scheme

    private var ink: Color {
        onDark ? WebContract.background.resolve(scheme).opacity(0.75)
               : WebContract.mutedForeground.resolve(scheme)
    }

    private var edge: Color {
        onDark ? WebContract.background.resolve(scheme).opacity(0.3)
               : WebContract.border.resolve(scheme)
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: glyph).font(.system(size: TimelineMetrics.capsuleFont))
            Text(label).lineLimit(1).truncationMode(.middle)
                .font(.system(size: TimelineMetrics.capsuleFont, design: .monospaced))
        }
        .foregroundStyle(ink)
        .padding(.horizontal, TimelineMetrics.chipPadH)
        .padding(.vertical, TimelineMetrics.chipPadV)
        .overlay {
            RoundedRectangle(cornerRadius: TimelineMetrics.chipRadius, style: .circular)
                .strokeBorder(edge, lineWidth: TimelineMetrics.hairline)
        }
    }
}

// MARK: - A run

/// The collapsed run capsule: what ran, how many steps, how many failed, how
/// long. `run-capsule.tsx`'s summary line, and only that line.
private struct RunRowView: View {
    let run: FoldedRun
    let width: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            RunCapsuleView(summary: FoldRuns.summarize(run.steps),
                           from: run.from, to: run.to)
                .frame(maxWidth: width * TimelineMetrics.maxWidthFraction, alignment: .leading)
            Spacer(minLength: 0)
        }
        .frame(width: width, alignment: .leading)
    }
}

private struct RunCapsuleView: View {
    let summary: RunSummary
    let from: String
    let to: String

    @Environment(\.colorScheme) private var scheme

    private var duration: String {
        guard let a = FoldRuns.parseDate(from), let b = FoldRuns.parseDate(to) else { return "" }
        return RunLabel.duration(seconds: b.timeIntervalSince(a))
    }

    var body: some View {
        // A run with no tool calls is a thinking block on its own — an assistant
        // turn of `[thinking, text]` produces one before every final reply, and
        // a full-width bar for each would be a rule across the conversation
        // every few paragraphs.
        if summary.calls == 0 && summary.thinkChars > 0 {
            ThinkingChip(chars: summary.thinkChars)
        } else {
            summaryLine
        }
    }

    private var summaryLine: some View {
        HStack(spacing: TimelineMetrics.capsuleGap) {
            // `▸`, which rotates when the capsule opens. It does not open yet;
            // the mark stays because it is what says it could.
            Text("▸")
                .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.6))
            Text(RunLabel.names(summary.names))
                .lineLimit(1).truncationMode(.tail)
                .foregroundStyle(WebContract.foreground.resolve(scheme).opacity(0.8))
            Spacer(minLength: 0)
            HStack(spacing: 6) {                        // gap-1.5
                if summary.errors > 0 {
                    Text("\(summary.errors) error\(summary.errors > 1 ? "s" : "")")
                        .foregroundStyle(StatusPalette.rose)
                }
                if summary.calls > 0 { Text("\(summary.calls) 步") }
                if !duration.isEmpty { Text("· \(duration)") }
            }
            .monospacedDigit()
            .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.7))
            .fixedSize()
        }
        .font(.system(size: TimelineMetrics.capsuleFont, design: .monospaced))
        .padding(.horizontal, TimelineMetrics.capsulePadH)
        .padding(.vertical, TimelineMetrics.capsulePadV)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WebContract.background.resolve(scheme),
                    in: RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular))
        .overlay {
            // Neutral even when a step failed — a tool error is routine, and a
            // rose outline on every such run trains the eye to ignore it. The
            // count carries the colour instead.
            RoundedRectangle(cornerRadius: TimelineMetrics.radius, style: .circular)
                .strokeBorder(WebContract.border.resolve(scheme), lineWidth: TimelineMetrics.hairline)
        }
    }
}

/// `💭 thinking · 1.2k`, the one-line form a run of pure reasoning collapses to.
private struct ThinkingChip: View {
    let chars: Int

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 6) {                            // gap-1.5
            Text("💭")
            Text("thinking").italic()
            if chars > 0 {
                Text("· \(RunLabel.chars(chars))")
                    .monospacedDigit()
                    .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.6))
            }
        }
        .font(.system(size: TimelineMetrics.capsuleFont, design: .monospaced))
        .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.8))
        .padding(.horizontal, TimelineMetrics.chipPadH)
        .padding(.vertical, TimelineMetrics.chipPadV)
        .background(WebContract.background.resolve(scheme),
                    in: RoundedRectangle(cornerRadius: TimelineMetrics.chipRadius, style: .circular))
        .overlay {
            RoundedRectangle(cornerRadius: TimelineMetrics.chipRadius, style: .circular)
                .strokeBorder(WebContract.border.resolve(scheme).opacity(0.6),
                              lineWidth: TimelineMetrics.hairline)
        }
    }
}

// MARK: - The turn that ended with nothing

private struct TerminatorRowView: View {
    let createdAt: String
    let now: Date

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Text("— turn ended without a reply · \(WebFormat.relTime(FoldRuns.parseDate(createdAt), now: now))")
                .font(.system(size: TimelineMetrics.capsuleFont, design: .monospaced))
                .italic()
                .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.7))
                .padding(.horizontal, TimelineMetrics.chipPadH)
                .padding(.vertical, TimelineMetrics.chipPadV)
                .overlay {
                    RoundedRectangle(cornerRadius: TimelineMetrics.chipRadius, style: .circular)
                        .strokeBorder(
                            WebContract.border.resolve(scheme),
                            style: StrokeStyle(lineWidth: TimelineMetrics.hairline, dash: [3, 3])
                        )
                }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - The three strings on a capsule

/// `run-capsule.tsx`'s three formatters, ported.
///
/// Small enough to look obviously right and not be. `fmtChars` is the one that
/// is not: JavaScript's `toFixed(1)` rounds a tie AWAY from zero ("pick the
/// larger n"), while C's `%.1f` — which `String(format:)` is — rounds a tie to
/// even, so 1250 characters would print as `1.3k` in the browser and `1.2k`
/// here. Hence the explicit `.toNearestOrAwayFromZero`.
enum RunLabel {
    /// The tool names, elided in the MIDDLE rather than the tail: the first tool
    /// says what the run started as and the count says how far it went.
    static func names(_ names: [String]) -> String {
        if names.isEmpty { return "thinking" }
        if names.count <= 3 { return names.joined(separator: " · ") }
        return names.prefix(3).joined(separator: " · ") + " +\(names.count - 3)"
    }

    /// `fmtDuration`, which takes milliseconds on the web. Under a second is
    /// no label at all.
    static func duration(seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds >= 1 else { return "" }
        let s = Int(seconds.rounded(.toNearestOrAwayFromZero))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        let rest = s % 60
        if m < 60 { return rest > 0 ? "\(m)m \(rest)s" : "\(m)m" }
        return "\(m / 60)h \(m % 60)m"
    }

    /// `fmtChars`.
    static func chars(_ n: Int) -> String {
        guard n >= 1000 else { return String(n) }
        let tenths = (Double(n) / 100).rounded(.toNearestOrAwayFromZero)
        let whole = Int(tenths) / 10
        let frac = Int(tenths) % 10
        return "\(whole).\(frac)k"
    }
}


// MARK: - Load earlier

/// The "↑ load earlier" pill that sits above the oldest message on screen.
///
/// `chat/page.tsx`: `flex justify-center` around an `inline-flex … rounded-full
/// border border-border bg-background px-3 py-1 text-xs text-muted-foreground`,
/// reading `loading…` while a page is in flight and dimmed to
/// `disabled:opacity-50` while it is.
///
/// Carries no vertical gap of its own — the web's `pb-3` is
/// `TimelineMetrics.earlierGap`, and the host applies whatever part of it its
/// own row spacing has not already paid. In the collection view each row cell
/// already carries half a `gap-3`; in the still-frame renderer the VStack
/// carries a whole one.
struct LoadEarlierPill: View {
    let loading: Bool
    var action: () -> Void = {}

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Button(action: action) {
                Text(loading ? "loading…" : "↑ load earlier")
                    .font(.system(size: TimelineMetrics.noticeFont))
                    .webLine(font: TimelineMetrics.noticeFont, box: TimelineMetrics.noticeLine)
                    .foregroundStyle(WebContract.mutedForeground.resolve(scheme))
                    .padding(.horizontal, TimelineMetrics.pillPadH)
                    .padding(.vertical, TimelineMetrics.pillPadV)
                    .background(WebContract.background.resolve(scheme), in: Capsule())
                    .overlay {
                        Capsule().strokeBorder(WebContract.border.resolve(scheme),
                                               lineWidth: TimelineMetrics.hairline)
                    }
            }
            .buttonStyle(.plain)
            .disabled(loading)
            // `disabled:opacity-50`. Applied to the whole pill, border included,
            // which is what the CSS does.
            .opacity(loading ? 0.5 : 1)
            Spacer(minLength: 0)
        }
    }
}
