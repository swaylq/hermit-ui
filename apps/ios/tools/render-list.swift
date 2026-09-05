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
// The rows are the states the sidebar can actually be in, one each, and the point
// is that every one of them is judged by SessionStatus — the port of the function
// the web row calls — rather than posed by hand. They live in
// tools/fixtures/session-rows.json so the web renderer draws the same eleven.

// `now` is injectable so the two renderers can agree on what "ago" means: the web
// row prints relTime() against ITS clock, this one against this process's, and two
// screenshots taken a second apart would differ in the "12s" column for no reason
// anyone cares about. tools/pixel-compare.sh sets HERMIT_FIXTURE_NOW once and hands
// the same epoch to both sides. Unset — the normal way this script is run — it is
// just the current time.
let now: Date = {
    if let ms = ProcessInfo.processInfo.environment["HERMIT_FIXTURE_NOW"],
       let v = Double(ms) {
        return Date(timeIntervalSince1970: v / 1000)
    }
    return Date()
}()

/// One row of `tools/fixtures/session-rows.json` — the file this renderer and the
/// web one both read. The rows used to be written out in Swift right here; they
/// moved to JSON the moment a second renderer existed, because a pixel comparison
/// between two lists proves nothing unless it is one list drawn twice.
///
/// Every instant arrives as SECONDS BEFORE `now` rather than as a timestamp: a
/// fixture with dates baked in silently becomes a different list every day, which
/// is the same trap `tools/bridge-fixture/server.py` fell into.
struct FixtureRow: Decodable {
    var id: String
    var agentName: String
    var title: String?
    var preview: String?
    var startedAtAgo: Double
    var lastMessageAtAgo: Double?
    var lastReadAtAgo: Double?
    var snapshotAtAgo: Double?
    var closedAtAgo: Double?
    var hiddenAtAgo: Double?
    var hibernatedAtAgo: Double?
    var restartRequestedAtAgo: Double?
    var alive: Bool?
    var state: String?
    var backgroundBusy: Bool?
    var backgroundNote: String?
    var active: Bool
    var pinned: Bool

    func item(now: Date) -> SessionListItem {
        func at(_ ago: Double?) -> Date? { ago.map { now.addingTimeInterval(-$0) } }
        return SessionListItem(
            id: id, agentName: agentName, title: title, preview: preview,
            startedAt: now.addingTimeInterval(-startedAtAgo),
            lastMessageAt: at(lastMessageAtAgo), lastReadAt: at(lastReadAtAgo),
            closedAt: at(closedAtAgo), hiddenAt: at(hiddenAtAgo),
            hibernatedAt: at(hibernatedAtAgo), restartRequestedAt: at(restartRequestedAtAgo),
            alive: alive, state: state, snapshotAt: at(snapshotAtAgo),
            backgroundBusy: backgroundBusy, backgroundNote: backgroundNote)
    }
}

struct RowFixture: Decodable { var rows: [FixtureRow] }

let SAMPLES: [(SessionListItem, Bool, Bool)] = {
    let path = ProcessInfo.processInfo.environment["HERMIT_ROWS_FIXTURE"]
        ?? "tools/fixtures/session-rows.json"
    guard let data = FileManager.default.contents(atPath: path) else {
        FileHandle.standardError.write(Data("render-list: cannot read \(path)\n".utf8))
        exit(1)
    }
    do {
        return try JSONDecoder().decode(RowFixture.self, from: data)
            .rows.map { ($0.item(now: now), $0.active, $0.pinned) }
    } catch {
        FileHandle.standardError.write(Data("render-list: \(path): \(error)\n".utf8))
        exit(1)
    }
}()

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

/// The screen before the first answer arrives. Its six bars are `recent-lists.tsx`'s
/// own markup, so this is where a wrong height or a wrong shade of
/// `--sidebar-accent` gets caught — on a loopback fixture the state is over
/// before a screenshot can be taken.
struct SkeletonMock: View {
    let scheme: ColorScheme
    var body: some View {
        SessionListSkeleton()
            .padding(.horizontal, 8)
            .frame(width: 320, height: 232, alignment: .top)
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
        shoot(SkeletonMock(scheme: .dark), "session-list-loading-dark", outDir)
        shoot(SkeletonMock(scheme: .light), "session-list-loading-light", outDir)
        // What each row was judged to be, so a wrong dot can be named rather
        // than squinted at.
        for (s, _, _) in SAMPLES {
            let v = SessionStatus.view(s.statusRow, StatusOptions(unread: s.unread))
            print("\(s.id)  \(v.key.rawValue)\t\(v.dot)\tpulse=\(v.pulse)\t\(v.label)")
        }
    }
}
