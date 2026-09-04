import ActivityKit
import SwiftUI
import WidgetKit

// The WidgetKit side of the presentation: turn an `ActivityViewContext` into a
// `SessionCard` and hand it to the views in SessionCardViews.swift.
//
// Kept this thin on purpose. Everything here is untestable by construction —
// the context type has no public initialiser — so the less that lives in it,
// the more of the layout can be looked at before it ships.

private func card(_ context: ActivityViewContext<SessionActivityAttributes>) -> SessionCard {
    SessionCard(
        sessionId: context.attributes.sessionId,
        agentName: context.attributes.agentName,
        machineName: context.attributes.machineName,
        phase: SessionPhase(context.state.phase),
        title: context.state.title,
        line: context.state.line,
        since: context.state.since,
        queued: context.state.queued,
        ctxPct: context.state.ctxPct
    )
}

struct SessionActivityBanner: View {
    let context: ActivityViewContext<SessionActivityAttributes>

    var body: some View {
        let c = card(context)
        SessionBannerBody(card: c)
            .activitySystemActionForegroundColor(c.phase.tint)
            .widgetURL(sessionURL(c.sessionId))
    }
}

enum SessionActivityIsland {
    static func island(_ context: ActivityViewContext<SessionActivityAttributes>) -> DynamicIsland {
        let c = card(context)

        return DynamicIsland {
            // Leading and trailing are the two narrow columns beside the camera;
            // one fact each and nothing else.
            DynamicIslandExpandedRegion(.leading) { IslandLeading(card: c) }
            DynamicIslandExpandedRegion(.trailing) { IslandTrailing(card: c) }
            // The centre region is the sliver BETWEEN those two, under the
            // cutout. The first version put the session title there and it came
            // out cramped and floating, a third column competing with the two
            // beside it. Left empty on purpose: everything it held reads better
            // in `bottom`, which is full width and directly below.
            DynamicIslandExpandedRegion(.bottom) {
                IslandBottom(card: c, link: sessionURL(c.sessionId))
            }
        } compactLeading: {
            // The app's own mark, coloured by what the session is doing — this
            // slot is the one place a person reads "which app" and "what state"
            // in the same glance.
            CrabMark(tint: c.phase.tint, size: 15)
        } compactTrailing: {
            if c.phase.showsTimer {
                Text(c.since, style: .timer)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(c.phase.tint)
                    // The compact island is a few dozen points wide. Without the
                    // cap a long-running turn pushes past an hour and the label
                    // is clipped mid-digit instead of shrinking.
                    .frame(maxWidth: 46)
                    .lineLimit(1)
            } else {
                Text(c.phase.shortLabel)
                    .font(.caption2)
                    .foregroundStyle(c.phase.tint)
            }
        } minimal: {
            CrabMark(tint: c.phase.tint, size: 15)
        }
        .widgetURL(sessionURL(c.sessionId))
        .keylineTint(c.phase.tint)
    }
}
