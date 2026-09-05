import AppKit
import SwiftUI

// Draws the NATIVE queue strip to PNGs, on this Mac, off the same table the web
// half reads — see tools/queue-compare.sh, which runs both and diffs them.
//
// Deliberately label-free, unlike render-composer.swift: every pixel in this
// canvas has a counterpart in the browser's, so a caption would diff against
// nothing. Same shape as render-list.swift, for the same reason.
struct QueueFixture: Decodable {
    struct Case: Decodable {
        var why: String
        var items: [String]
        var clearing: Bool
    }
    var width: CGFloat
    var gap: CGFloat
    var cases: [Case]
}

struct QueueStrips: View {
    let scheme: ColorScheme
    let fixture: QueueFixture

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(fixture.cases.enumerated()), id: \.offset) { _, c in
                QueueBarView(
                    model: QueueBarModel(
                        items: c.items.enumerated().map { j, text in
                            QueueBarItem(id: "q\(j)", label: QueueCore.itemLabel(text))
                        },
                        clearing: c.clearing
                    ),
                    onCancel: { _ in }, onClear: {}
                )
                .padding(.bottom, fixture.gap)
            }
        }
        .frame(width: fixture.width, alignment: .topLeading)
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
        let path = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "tools/fixtures/queue-bar.json"
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let fixture = try? JSONDecoder().decode(QueueFixture.self, from: data) else {
            FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!)
            exit(2)
        }
        shoot(QueueStrips(scheme: .dark, fixture: fixture), "queue-strip-dark", outDir)
        shoot(QueueStrips(scheme: .light, fixture: fixture), "queue-strip-light", outDir)
        for c in fixture.cases { print("  · \(QueueCore.summary(c.items.count))  — \(c.why)") }
    }
}
