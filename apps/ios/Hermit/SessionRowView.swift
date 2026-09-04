import SwiftUI

/// One session, drawn the way `components/sidebar/recent-lists.tsx` draws it.
///
/// Every number here is that file's Tailwind class read as CSS pixels — `gap-2`
/// is 8, `px-2.5` is 10, `text-[13px]` is 13 — and every colour comes from
/// `WebContract`, which is generated from the same stylesheet the browser uses.
/// Nothing is re-judged on this side: the dot, its opacity, the label and
/// whether a label is printed at all come out of `SessionStatus.view`, the port
/// of the function the web row calls.
///
/// SwiftUI and no UIKit on purpose. That is what lets `tools/render-list.sh`
/// compile this for the Mac and write the layout to a PNG in a couple of
/// seconds — no simulator, no signing, no server — which is the only way this
/// gets LOOKED at often enough to stay honest.
struct SessionRowView: View {
    let session: SessionListItem
    let status: StatusView
    /// The row you are on. `bg-sidebar-accent`, and the title goes to full
    /// weight and full opacity.
    var active: Bool = false
    var pinned: Bool = false
    /// Frozen for a screenshot; `nil` means "now", which is what the app passes.
    var now: Date = Date()

    @Environment(\.colorScheme) private var scheme

    /// `opacity-60` closed · `opacity-50` hidden · `opacity-60` asleep. The web
    /// stacks these classes, so the last one that applies wins rather than them
    /// multiplying — `hiddenAt` is the strongest and comes last there too.
    private var rowOpacity: Double {
        if session.hiddenAt != nil { return 0.5 }
        if session.closedAt != nil { return 0.6 }
        if session.hibernatedAt != nil { return 0.6 }
        return 1
    }

    private var titleColor: Color {
        WebContract.sidebarForeground.resolve(scheme).opacity(active ? 1 : 0.85)
    }
    private var muted: Color { WebContract.mutedForeground.resolve(scheme) }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {           // gap-2
            StatusDot(status: status)
                .padding(.top, 6)                       // mt-1.5, against a 13px line
            VStack(alignment: .leading, spacing: 2) {   // mt-0.5 on the second line
                HStack(alignment: .firstTextBaseline, spacing: 6) {   // gap-1.5
                    Text(session.displayTitle)
                        .font(.system(size: 13, weight: active ? .medium : .regular))
                        .foregroundStyle(titleColor)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                    // `self-center` on all three: they sit on the line's centre,
                    // not its baseline, which is why they are pulled out of the
                    // baseline alignment above.
                    if pinned { RowGlyph("pin.fill", muted.opacity(0.7), rotated: -45) }
                    if session.hiddenAt != nil { RowGlyph("eye.slash", muted.opacity(0.6)) }
                    if session.hibernatedAt != nil { RowGlyph("moon", muted.opacity(0.6)) }
                    Text(WebFormat.relTime(session.recencyAt, now: now))
                        .font(.system(size: 10, design: .monospaced))
                        .monospacedDigit()
                        .foregroundStyle(muted.opacity(0.6))
                        .fixedSize()
                }
                HStack(spacing: 6) {
                    Text(session.agentName)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    // A label for everything EXCEPT the resting states — the
                    // reason is in session-status.ts and in the web row: with
                    // claude-sdk most of this list has no live child at any
                    // moment, so labelling it prints the same word all the way
                    // down. The dimmed dot carries it instead.
                    if !SessionStatus.isRestingState(status.key) {
                        Text("·").foregroundStyle(muted.opacity(0.4))
                        Text(status.label).fixedSize()
                    }
                    Spacer(minLength: 0)
                }
                .font(.system(size: 10, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(muted.opacity(0.75))
            }
        }
        .padding(.horizontal, 10)                       // px-2.5
        .padding(.vertical, 6)                          // py-1.5
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            active ? WebContract.sidebarAccent.resolve(scheme) : .clear,
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)   // rounded-lg
        )
        .opacity(rowOpacity)
        .contentShape(Rectangle())
    }
}

/// The 6pt dot, including the pulse.
///
/// `StatusPalette.dot` is the only thing that turns the web's class string into
/// a colour; a class this build has never heard of draws a hollow ring rather
/// than a guessed colour or nothing at all — a new state added on the web should
/// look unfamiliar, not invisible.
private struct StatusDot: View {
    let status: StatusView
    @State private var dim = false

    var body: some View {
        let resolved = StatusPalette.dot(status.dot)
        Group {
            if let resolved {
                Circle().fill(resolved.color.opacity(resolved.opacity))
            } else {
                Circle().strokeBorder(Color.secondary, lineWidth: 1)
            }
        }
        .frame(width: 6, height: 6)                     // h-1.5 w-1.5
        // Tailwind's `animate-pulse`: opacity 1 → 0.5 → 1 over 2s, forever.
        .opacity(status.pulse && dim ? 0.5 : 1)
        .animation(
            status.pulse
                ? .easeInOut(duration: 1).repeatForever(autoreverses: true)
                : .default,
            value: dim
        )
        .onAppear { if status.pulse { dim = true } }
    }
}

/// One of the three 12pt trailing marks.
private struct RowGlyph: View {
    let name: String
    let color: Color
    var rotated: Double = 0

    init(_ name: String, _ color: Color, rotated: Double = 0) {
        self.name = name
        self.color = color
        self.rotated = rotated
    }

    var body: some View {
        Image(systemName: name)
            .font(.system(size: 12))                    // h-3 w-3
            .foregroundStyle(color)
            .rotationEffect(.degrees(rotated))
            .frame(width: 12, height: 12)
    }
}
