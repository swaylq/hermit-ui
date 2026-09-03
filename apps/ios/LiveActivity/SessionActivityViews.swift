import ActivityKit
import SwiftUI
import WidgetKit

// The Live Activity's four presentations: the Lock Screen banner, and the
// Dynamic Island's compact, minimal and expanded forms.
//
// One rule shaped all of them — a lock screen is read at arm's length, in under
// a second, often through a glance that was really about the time. So each
// presentation answers the questions in the same order, and the smaller it gets
// the fewer it answers:
//
//   minimal  → is it waiting on me?
//   compact  → …and how long has it been?
//   expanded → …and which session, and what is it doing?
//   banner   → the same, with room for the line to breathe
//
// Nothing here animates on its own. The elapsed time is a system timer, which
// ticks once a second with no push behind it; that is the only motion, and it is
// enough to read as live. A spinner would have to be faked with pushes, and a
// push per second is neither allowed nor useful.

// MARK: - Phase presentation

private extension SessionPhase {
    var tint: Color {
        switch self {
        case .working: return .cyan
        case .blocked: return .orange   // the only "you" colour, used nowhere else
        case .done:    return .green
        case .failed:  return .red
        }
    }

    var symbol: String {
        switch self {
        case .working: return "circle.hexagongrid"
        case .blocked: return "hand.raised.fill"
        case .done:    return "checkmark.circle.fill"
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

private func url(for sessionId: String) -> URL? {
    URL(string: "hermit://session/\(sessionId)")
}

// MARK: - Lock Screen / banner

struct SessionActivityBanner: View {
    let context: ActivityViewContext<SessionActivityAttributes>

    private var phase: SessionPhase { SessionPhase(context.state.phase) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: phase.symbol)
                    .font(.caption)
                    .foregroundStyle(phase.tint)
                Text(context.attributes.agentName)
                    .font(.footnote.weight(.semibold))
                    .monospaced()
                if let machine = context.attributes.machineName {
                    Text(machine)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if phase.showsTimer {
                    // Counts up from the start of THIS phase, not of the session.
                    Text(context.state.since, style: .timer)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(phase.tint)
                        .lineLimit(1)
                        // A timer's width changes as it crosses 10s, 10m, 1h.
                        // Without a fixed box the whole row jitters once a second.
                        .frame(minWidth: 44, alignment: .trailing)
                }
            }

            // The line the whole thing exists to carry. Two lines, because a
            // question worth interrupting you is usually a sentence, and one
            // line truncates it exactly where the verb is.
            Text(context.state.line)
                .font(.subheadline)
                .foregroundStyle(phase == .blocked ? .primary : .secondary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Text(context.state.title)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                QueueBadge(count: context.state.queued)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .activityBackgroundTint(nil)     // let the system pick; it matches the wallpaper
        .activitySystemActionForegroundColor(phase.tint)
        .widgetURL(url(for: context.attributes.sessionId))
    }
}

// MARK: - Dynamic Island

struct SessionActivityIsland {
    static func island(_ context: ActivityViewContext<SessionActivityAttributes>) -> DynamicIsland {
        let phase = SessionPhase(context.state.phase)

        return DynamicIsland {
            DynamicIslandExpandedRegion(.leading) {
                HStack(spacing: 5) {
                    Image(systemName: phase.symbol)
                        .font(.caption)
                        .foregroundStyle(phase.tint)
                    Text(context.attributes.agentName)
                        .font(.footnote.weight(.semibold))
                        .monospaced()
                        .lineLimit(1)
                }
            }
            DynamicIslandExpandedRegion(.trailing) {
                if phase.showsTimer {
                    Text(context.state.since, style: .timer)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(phase.tint)
                        .lineLimit(1)
                        .frame(minWidth: 44, alignment: .trailing)
                } else {
                    Text(phase.shortLabel)
                        .font(.caption)
                        .foregroundStyle(phase.tint)
                }
            }
            DynamicIslandExpandedRegion(.center) {
                Text(context.state.title)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            DynamicIslandExpandedRegion(.bottom) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(context.state.line)
                        .font(.subheadline)
                        .foregroundStyle(phase == .blocked ? .primary : .secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    // Only when it is actually waiting on a human. A button that
                    // is always there teaches you to ignore it, and this is the
                    // one moment the island has something to ask for.
                    if phase == .blocked, let link = url(for: context.attributes.sessionId) {
                        Link(destination: link) {
                            Text("去回答")
                                .font(.footnote.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 7)
                                .background(phase.tint.opacity(0.22), in: Capsule())
                        }
                        .tint(phase.tint)
                    } else {
                        QueueBadge(count: context.state.queued)
                    }
                }
            }
        } compactLeading: {
            Image(systemName: phase.symbol)
                .font(.caption2)
                .foregroundStyle(phase.tint)
        } compactTrailing: {
            if phase.showsTimer {
                Text(context.state.since, style: .timer)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(phase.tint)
                    // The compact island is a few dozen points wide. Without the
                    // cap a long-running turn pushes past an hour and the label
                    // is clipped mid-digit instead of shrinking.
                    .frame(maxWidth: 46)
                    .lineLimit(1)
            } else {
                Text(phase.shortLabel)
                    .font(.caption2)
                    .foregroundStyle(phase.tint)
            }
        } minimal: {
            Image(systemName: phase.symbol)
                .font(.caption2)
                .foregroundStyle(phase.tint)
        }
        .widgetURL(url(for: context.attributes.sessionId))
        .keylineTint(phase.tint)
    }
}

// MARK: - Bits

/// "+3" when messages are stacked behind the running one. Nothing at all when
/// there are none — an empty badge is a thing to decode for no information.
private struct QueueBadge: View {
    let count: Int?

    var body: some View {
        if let n = count, n > 0 {
            Text("排队 \(n)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.quaternary, in: Capsule())
        }
    }
}
