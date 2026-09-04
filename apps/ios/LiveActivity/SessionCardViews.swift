import SwiftUI

// The Lock Screen and Dynamic Island layouts, drawn from plain values.
//
// Nothing here imports ActivityKit or WidgetKit: the pieces take a `SessionCard`
// and the WidgetKit shells that feed them live next door in
// SessionActivityViews.swift. That split is not tidiness — an
// `ActivityViewContext` cannot be constructed outside the system, so views that
// depend on one can only be looked at by shipping a build to a device and
// starting a real turn. These can be rendered anywhere, which is how the layout
// below was actually checked rather than guessed at.
//
// One rule shaped all of them — a lock screen is read at arm's length, in under
// a second, often through a glance that was really about the time. So each
// presentation answers the same questions in the same order, and the smaller it
// gets the fewer it answers:
//
//   minimal  → is it waiting on me?
//   compact  → …and how long has it been?
//   expanded → …and which session, what is it doing, how full is the window?
//   banner   → the same, with room for the line to breathe
//
// Nothing animates on its own. The elapsed time is a system timer, which ticks
// once a second with no push behind it; that is the only motion, and it is
// enough to read as live. A spinner would have to be faked with pushes, and a
// push per second is neither allowed nor useful.

// MARK: - Phase presentation

extension SessionPhase {
    /// Straight from the web app's spec — see StatusPalette. Nothing is chosen
    /// here; a Lock Screen with its own idea of what "working" looks like is the
    /// same drift `session-status.ts` exists to prevent.
    var tint: Color {
        switch self {
        // One hue for both, as the spec has it: a blocked turn IS mid-turn. What
        // separates them on the web is the pulse, and here it is the symbol, the
        // button and the alert.
        case .working, .blocked: return StatusPalette.amber
        // Not green. A turn that just finished is "unread" in this product's
        // vocabulary, and unread is red — you have something to go read.
        case .done:   return StatusPalette.rose
        // A turn that died leaves a session with no live process: "down".
        case .failed: return StatusPalette.zinc
        }
    }

    /// A second glyph, only where there is room for one and only for the state
    /// that has something to say beyond its colour. Working and blocked share a
    /// hue by design (see StatusPalette), so this is what carries the difference
    /// in the presentations wide enough to show it.
    var badge: String? {
        switch self {
        case .working: return nil
        case .blocked: return "hand.raised.fill"
        case .done:    return "checkmark"
        case .failed:  return "exclamationmark.triangle.fill"
        }
    }

    /// Two or three characters. Anything longer squeezes the timer out of the
    /// compact island, which is the more useful of the two.
    var shortLabel: String {
        switch self {
        case .working: return "运行"
        case .blocked: return "待答"
        case .done:    return "完成"
        case .failed:  return "失败"
        }
    }

    /// Does the elapsed time still mean anything? While working and while
    /// blocked it is the headline number — how long you have been waiting, and
    /// how long IT has been waiting on you. After the turn ends it is just a
    /// clock counting up from a finished thing, so the views drop it.
    var showsTimer: Bool { self == .working || self == .blocked }
}

/// The only URL this app answers to. Built here, consumed by SceneDelegate.
func sessionURL(_ sessionId: String) -> URL? {
    URL(string: "hermit://session/\(sessionId)")
}

/// Hermit's own mark, tinted by what the session is doing.
///
/// The same file the dashboard uses (`public/logo-crab-mono.png`, an alpha
/// silhouette it tints with CSS), imported as a template image so it takes a
/// `foregroundStyle` here the same way. Using the app icon instead would not
/// work and would be wrong twice over: it is a full-colour raster with its own
/// background, and a mark that cannot take the state colour is exactly what this
/// slot must not be.
/// Where the mark comes from.
///
/// Defaults to the asset the widget extension ships. Injectable because these
/// views are also compiled by `tools/render-cards`, which has no asset catalog
/// to resolve a name against — and a layout that cannot be rendered is one that
/// can only be checked by shipping it.
private struct CrabImageKey: EnvironmentKey {
    static let defaultValue = Image("CrabMark")
}

extension EnvironmentValues {
    var crabImage: Image {
        get { self[CrabImageKey.self] }
        set { self[CrabImageKey.self] = newValue }
    }
}

struct CrabMark: View {
    @Environment(\.crabImage) private var crabImage
    let tint: Color
    var size: CGFloat = 15

    var body: some View {
        crabImage
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(tint)
    }
}

// MARK: - Pieces

/// How full the context window is: `ctx ▓▓░ 41%`.
///
/// The sidebar's cut, not the chat header's — percent and bar, no token count.
/// The count is a number that moves every few seconds and every move here is an
/// APNs push; the percent moves a hundred times in a session's life. Shown in
/// every state including "no completed turn yet", where it reads `ctx —`, per
/// the web app's rule that the context share is never absent.
struct CtxMeter: View {
    let pct: Int?

    private var known: Bool { pct != nil }
    private var value: Int { pct ?? 0 }

    var body: some View {
        HStack(spacing: 4) {
            Text("ctx")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Capsule()
                .fill(.quaternary)
                .frame(width: 26, height: 3)
                .overlay(alignment: .leading) {
                    if known {
                        Capsule()
                            .fill(StatusPalette.ctxBar(value))
                            // A 2pt floor so 1% is a mark rather than nothing —
                            // the same `Math.max(2, …)` the web bar uses.
                            .frame(width: max(2, 26 * CGFloat(min(100, value)) / 100), height: 3)
                    }
                }
            Text(known ? "\(value)%" : "—")
                .font(.caption2.monospacedDigit())
                // AnyShapeStyle because the two branches are different types —
                // a Color and the hierarchical `.tertiary` — and a ternary makes
                // the compiler pick one.
                .foregroundStyle(known ? AnyShapeStyle(StatusPalette.ctxText(value)) : AnyShapeStyle(.tertiary))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(known ? "上下文 \(value)%" : "上下文未知")
    }
}

/// "排队 3" when messages are stacked behind the running one, nothing when there
/// are none — an empty badge is a thing to decode for no information.
struct QueueBadge: View {
    let count: Int?

    var body: some View {
        if let n = count, n > 0 {
            Text("排队 \(n)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 5)
                .padding(.vertical, 1.5)
                .background(.quaternary, in: Capsule())
        }
    }
}

/// The elapsed time, drawn by the system once a second with no push behind it.
struct PhaseTimer: View {
    let since: Date
    let tint: Color

    var body: some View {
        Text(since, style: .timer)
            .font(.footnote.monospacedDigit().weight(.medium))
            .foregroundStyle(tint)
            .lineLimit(1)
            // A timer's width changes as it crosses 10s, 10m and 1h. Without a
            // fixed box the row it sits in twitches once a second.
            .frame(minWidth: 46, alignment: .trailing)
    }
}


// MARK: - The card, at three sizes

/// The Lock Screen banner, and the widest thing this draws.
struct SessionBannerBody: View {
    let card: SessionCard

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                CrabMark(tint: card.phase.tint, size: 16)
                if let badge = card.phase.badge {
                    Image(systemName: badge)
                        .font(.caption2)
                        .foregroundStyle(card.phase.tint)
                }
                Text(card.agentName)
                    .font(.footnote.weight(.semibold))
                    .monospaced()
                if let machine = card.machineName {
                    Text(machine)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                TrailingValue(card: card)
            }

            // The line the whole thing exists to carry. Two lines, because a
            // question worth interrupting you is usually a sentence and one line
            // truncates it right where the verb is.
            Text(card.line)
                .font(.subheadline)
                .foregroundStyle(card.phase == .blocked ? .primary : .secondary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            MetaRow(card: card)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

/// The expanded island's left column: who.
struct IslandLeading: View {
    let card: SessionCard

    var body: some View {
        HStack(spacing: 5) {
            CrabMark(tint: card.phase.tint, size: 17)
            if let badge = card.phase.badge {
                Image(systemName: badge)
                    .font(.caption2)
                    .foregroundStyle(card.phase.tint)
            }
            Text(card.agentName)
                .font(.footnote.weight(.semibold))
                .monospaced()
                .lineLimit(1)
        }
        .padding(.leading, 2)
    }
}

/// The expanded island's right column: the one live number.
struct IslandTrailing: View {
    let card: SessionCard

    var body: some View {
        TrailingValue(card: card).padding(.trailing, 2)
    }
}

/// The expanded island's full-width band. Everything that needs room is here.
struct IslandBottom: View {
    let card: SessionCard
    /// `nil` in a render harness, where there is nothing to open.
    var link: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(card.line)
                .font(.callout)
                .foregroundStyle(card.phase == .blocked ? .primary : .secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            MetaRow(card: card)

            // Only when it is actually waiting on a human. A button that is
            // always there teaches you to ignore it, and this is the one moment
            // the island has something to ask for.
            if card.phase == .blocked {
                AnswerButton(tint: card.phase.tint, link: link).padding(.top, 1)
            }
        }
        .padding(.top, 2)
    }
}

// MARK: - Shared rows

/// Which session, what is queued, how full the window is. One row, because all
/// three are things you check rather than read.
private struct MetaRow: View {
    let card: SessionCard

    var body: some View {
        HStack(spacing: 8) {
            Text(card.title)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            QueueBadge(count: card.queued)
            Spacer(minLength: 6)
            CtxMeter(pct: card.ctxPct)
        }
    }
}

/// The elapsed timer while it means something, the state's name once it does not.
private struct TrailingValue: View {
    let card: SessionCard

    var body: some View {
        if card.phase.showsTimer {
            PhaseTimer(since: card.since, tint: card.phase.tint)
        } else {
            Text(card.phase.shortLabel)
                .font(.footnote.weight(.medium))
                .foregroundStyle(card.phase.tint)
        }
    }
}

private struct AnswerButton: View {
    let tint: Color
    let link: URL?

    private var label: some View {
        Text("去回答")
            .font(.footnote.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            // A hairline plus a lighter fill. At 0.22 alone the amber went muddy
            // olive against black and read as a painted block rather than
            // something you press; the edge is what makes it a control.
            .background(tint.opacity(0.16), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.45), lineWidth: 1))
    }

    var body: some View {
        if let link {
            Link(destination: link) { label }.tint(tint)
        } else {
            label.foregroundStyle(tint)
        }
    }
}
