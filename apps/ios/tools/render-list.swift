import AppKit
import SwiftUI

// Draws the native session list to PNGs, on this Mac, with no simulator, no
// signing and no server. Not shipped — see tools/render-list.sh.
//
// The same trick `render-cards.swift` plays on the Live Activity, and the reason
// SessionRowView.swift is pure SwiftUI over a plain value: a layout you have to
// build, install and sign in to LOOK at is a layout nobody looks at. This takes
// about five seconds, so a change to a padding number gets checked with eyes
// instead of with hope.
//
// The rows below are the states the sidebar can actually be in, one each, and
// the point is that every one of them is judged by SessionStatus — the port of
// the function the web row calls — rather than posed by hand.

let now = Date()
func ago(_ s: TimeInterval) -> Date { now.addingTimeInterval(-s) }

func row(
    _ id: String, _ agent: String, title: String?, preview: String? = nil,
    msg: TimeInterval? = 90, read: TimeInterval? = 0, snapshot: TimeInterval? = 4,
    alive: Bool? = true, state: String? = "idle",
    closed: Bool = false, hidden: Bool = false, asleep: Bool = false,
    restartAgo: TimeInterval? = nil, bgBusy: Bool? = nil, bgNote: String? = nil
) -> SessionListItem {
    SessionListItem(
        id: id, agentName: agent, title: title, preview: preview,
        startedAt: ago(86_400 * 3),
        lastMessageAt: msg.map(ago), lastReadAt: read.map(ago),
        closedAt: closed ? ago(600) : nil,
        hiddenAt: hidden ? ago(600) : nil,
        hibernatedAt: asleep ? ago(600) : nil,
        restartRequestedAt: restartAgo.map(ago),
        alive: alive, state: state, snapshotAt: snapshot.map(ago),
        backgroundBusy: bgBusy, backgroundNote: bgNote
    )
}

let SAMPLES: [(SessionListItem, Bool, Bool)] = [   // row, active, pinned
    (row("a", "asst", title: "iOS 原生化 — 会话列表", msg: 12, read: 12, state: "working"), true, false),
    (row("b", "sway", title: "hermit-ui 部署凭据", msg: 400, read: 400, state: "idle",
         bgBusy: true, bgNote: "background · 1h 28m"), false, true),
    (row("c", "asst", title: nil, preview: "把 planSync 移植成 Swift，顺手把 FTS5 的分词器换掉",
         msg: 30, read: 3600), false, false),
    (row("d", "brain", title: "Longer than the row is wide — a title that has to truncate somewhere",
         msg: 7_200, read: 0, state: "idle"), false, false),
    (row("e", "asst", title: "启动中", msg: 60, read: 60, state: "starting"), false, false),
    (row("f", "asst", title: "重启中", msg: 60, read: 60, state: "idle", restartAgo: 3), false, false),
    (row("g", "asst", title: "网关沉默了", msg: 900, read: 900, snapshot: 600, state: "working"), false, false),
    (row("h", "asst", title: "睡着了", msg: 40_000, read: 0, alive: false, state: nil, asleep: true), false, false),
    (row("i", "asst", title: "归档了", msg: 300_000, read: 0, closed: true), false, false),
    (row("j", "asst", title: "藏起来了", msg: 300_000, read: 0, hidden: true), false, false),
    (row("k", "asst", title: "", preview: "", msg: nil, read: nil, snapshot: nil,
         alive: nil, state: nil), false, false),
]

struct ListMock: View {
    let scheme: ColorScheme
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(SAMPLES.enumerated()), id: \.offset) { _, s in
                SessionRowView(
                    session: s.0,
                    status: SessionStatus.view(s.0.statusRow, StatusOptions(unread: s.0.unread)),
                    active: s.1, pinned: s.2, now: now
                )
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(width: 320, alignment: .leading)
        .background(WebContract.sidebar.resolve(scheme))
        .environment(\.colorScheme, scheme)
    }
}

@MainActor func shoot(_ view: some View, _ name: String, _ outDir: String) {
    let r = ImageRenderer(content: view)
    r.scale = 3
    guard let img = r.nsImage, let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    print("wrote \(name).png")
}

@main
enum Main {
    @MainActor static func main() {
        let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
        shoot(ListMock(scheme: .dark), "session-list-dark", outDir)
        shoot(ListMock(scheme: .light), "session-list-light", outDir)
        // What each row was judged to be, so a wrong dot can be named rather
        // than squinted at.
        for (s, _, _) in SAMPLES {
            let v = SessionStatus.view(s.statusRow, StatusOptions(unread: s.unread))
            print("\(s.id)  \(v.key.rawValue)\t\(v.dot)\tpulse=\(v.pulse)\t\(v.label)")
        }
    }
}
