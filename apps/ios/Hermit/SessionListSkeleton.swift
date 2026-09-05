import SwiftUI

/// What the list shows before it has ever had an answer.
///
/// The web draws exactly this — `recent-lists.tsx`:
///
/// ```tsx
/// {sessions.isPending ? (
///   <div className="space-y-1 px-1 pt-1">
///     {Array.from({ length: 6 }).map((_, i) => (
///       <div key={i} className="h-8 rounded-md bg-sidebar-accent/40 animate-pulse" />
///     ))}
///   </div>
/// ) : …}
/// ```
///
/// so the six bars, their height, their gap and the four-tenths of
/// `--sidebar-accent` are that markup read as CSS pixels, not a look invented
/// here.
///
/// It matters more on the phone than in the browser. `chat.listSessions` is the
/// 90 KB query, and against a real dashboard over a cellular link the first
/// answer can be tens of seconds out; until this existed that whole time was a
/// blank screen with no way to tell "still loading" from "this build is broken".
/// The loopback fixture answers instantly, which is exactly why the gap survived
/// two rounds of driving the list on a simulator.
///
/// Pure SwiftUI over no data at all, for the reason `SessionRowView` is:
/// `tools/render-list.sh` compiles it for the Mac and writes it to a PNG in
/// about five seconds, so it gets LOOKED at.
struct SessionListSkeleton: View {
    var rows: Int = 6

    @Environment(\.colorScheme) private var scheme
    @State private var dim = false

    var body: some View {
        VStack(spacing: 4) {                                    // space-y-1
            ForEach(0..<rows, id: \.self) { _ in
                RoundedRectangle(cornerRadius: 6, style: .continuous)   // rounded-md
                    .fill(WebContract.sidebarAccent.resolve(scheme).opacity(0.4))  // /40
                    .frame(height: 32)                          // h-8
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)                                // px-1
        .padding(.top, 4)                                       // pt-1
        // Tailwind's `animate-pulse`, the same 2s cycle the status dot uses.
        .opacity(dim ? 0.5 : 1)
        .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: dim)
        .onAppear { dim = true }
        // A placeholder is scenery. Left visible it would be read aloud as six
        // anonymous elements between the title and the first real row.
        .accessibilityHidden(true)
    }
}
