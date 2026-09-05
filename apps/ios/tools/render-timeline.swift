import AppKit
import SwiftUI

// Draws the native chat timeline to PNGs, on this Mac, with no simulator, no
// signing and no server. Not shipped — see tools/render-timeline.sh.
//
// Same trick as render-list.swift, one screen further in, and the reason
// TimelineRowView.swift is pure SwiftUI over a plain value. The rows are not
// posed: the fixture is RAW messages, they go through FoldRuns.fold, and what
// lands on the canvas is what the fold decided this conversation is made of.

let now: Date = {
    if let ms = ProcessInfo.processInfo.environment["HERMIT_FIXTURE_NOW"], let v = Double(ms) {
        return Date(timeIntervalSince1970: v / 1000)
    }
    return Date()
}()

private let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

/// One message of `tools/fixtures/timeline-cases.json`.
struct FixtureMessage: Decodable {
    var id: String
    var role: String
    var authoredBy: String?
    /// Seconds before `now`, never a timestamp — see the note in the fixture.
    var createdAtAgo: Double
    var content: JSONValue

    func input(now: Date) -> FoldInput {
        FoldInput(id: id, role: role, content: content,
                  createdAt: iso.string(from: now.addingTimeInterval(-createdAtAgo)),
                  authoredBy: authoredBy)
    }
}

struct TimelineFixture: Decodable { var messages: [FixtureMessage] }

let ROWS: [FoldedRow] = {
    let path = ProcessInfo.processInfo.environment["HERMIT_TIMELINE_FIXTURE"]
        ?? "tools/fixtures/timeline-cases.json"
    guard let data = FileManager.default.contents(atPath: path) else {
        FileHandle.standardError.write(Data("render-timeline: cannot read \(path)\n".utf8))
        exit(1)
    }
    do {
        let f = try JSONDecoder().decode(TimelineFixture.self, from: data)
        return FoldRuns.fold(f.messages.map { $0.input(now: now) })
    } catch {
        FileHandle.standardError.write(Data("render-timeline: \(path): \(error)\n".utf8))
        exit(1)
    }
}()

/// A phone's width, and the column inside it: `px-4` on the web's scroller.
let CANVAS_WIDTH: CGFloat = 390          // iPhone 15 / 16 point width
let PAD_H: CGFloat = 16
let CONTENT_WIDTH: CGFloat = CANVAS_WIDTH - PAD_H * 2

struct TimelineMock: View {
    let scheme: ColorScheme
    var body: some View {
        VStack(alignment: .leading, spacing: TimelineMetrics.rowGap) {
            // Drawn at the top, where the collection view puts it: the item
            // after the oldest row in a list that is upside down. Its `pb-3` is
            // already paid by this VStack's `gap-3`, so it adds nothing here.
            LoadEarlierPill(loading: false)
            ForEach(Array(ROWS.enumerated()), id: \.offset) { _, row in
                TimelineRowView(row: row, width: CONTENT_WIDTH, now: now)
            }
        }
        .padding(.horizontal, PAD_H)
        .padding(.vertical, 16)                  // py-4
        .frame(width: CANVAS_WIDTH, alignment: .topLeading)
        .background(WebContract.background.resolve(scheme))
        .environment(\.colorScheme, scheme)
    }
}

/// The "load earlier" pill in both states, on the page background.
struct PillStates: View {
    let scheme: ColorScheme
    var body: some View {
        VStack(alignment: .leading, spacing: TimelineMetrics.rowGap) {
            LoadEarlierPill(loading: false)
            LoadEarlierPill(loading: true)
        }
        .padding(.horizontal, PAD_H)
        .padding(.vertical, 16)
        .frame(width: CANVAS_WIDTH, alignment: .topLeading)
        .background(WebContract.background.resolve(scheme))
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
    print("wrote \(name).png  (\(Int(img.size.width))×\(Int(img.size.height)) pt)")
}

@main
enum Main {
    @MainActor static func main() {
        let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
        shoot(TimelineMock(scheme: .dark), "timeline-dark", outDir)
        shoot(TimelineMock(scheme: .light), "timeline-light", outDir)
        // Both pill states, larger than they appear above, because the only
        // difference between them is a word and `disabled:opacity-50`.
        shoot(PillStates(scheme: .dark), "timeline-earlier-dark", outDir)
        shoot(PillStates(scheme: .light), "timeline-earlier-light", outDir)

        // What the fold made of the fixture, so a wrong row can be NAMED rather
        // than squinted at — the same reason render-list.swift prints its
        // status verdicts.
        print("")
        for row in ROWS {
            switch row {
            case .msg(let m):
                let kinds = m.blocks.map(\.kind).joined(separator: ",")
                print("msg   \(m.key)\trole=\(m.role)\tauthoredBy=\(m.authoredBy ?? "-")\tblocks=[\(kinds)]")
            case .run(let r):
                let s = FoldRuns.summarize(r.steps)
                print("run   \(r.key)\tnames=\(RunLabel.names(s.names))\tcalls=\(s.calls)\terrors=\(s.errors)\tthink=\(RunLabel.chars(s.thinkChars))")
            case .end(let e):
                print("end   \(e.key)")
            }
        }

        // The three capsule formatters, printed for the same inputs the web's
        // are, so `run-capsule.tsx` and `RunLabel` can be diffed instead of
        // read. See tools/render-timeline.sh.
        print("")
        for n in [0, 1, 999, 1000, 1049, 1050, 1250, 1749, 1750, 2450, 9999, 123456] {
            print("chars \(n)\t\(RunLabel.chars(n))")
        }
        for ms in [0, 999, 1000, 1499, 1500, 59_000, 59_500, 60_000, 61_000, 3_599_000, 3_600_000, 7_260_000] {
            print("dur \(ms)\t\(RunLabel.duration(seconds: Double(ms) / 1000))")
        }
        for names in [[], ["Read"], ["Read", "Bash"], ["Read", "Bash", "Edit"],
                      ["Read", "Bash", "Edit", "Grep"], ["Read", "Bash", "Edit", "Grep", "Write"]] {
            print("names \(names.joined(separator: "|"))\t\(RunLabel.names(names))")
        }
    }
}
