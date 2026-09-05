import AppKit
import SwiftUI

// Draws the native press-and-hold overlay to PNGs, on this Mac, off the same
// table the web half reads. Not shipped — see tools/render-hold.sh, and
// tools/hold-compare.sh for the pair.
//
// One canvas, the cases laid out side by side with a fixed gutter, so the two
// images are the same size and `png-diff` can subtract them without alignment.
// Side by side rather than stacked because each case IS a screen: 393×852.
//
// Drawn over the app's own LIGHT background on both sides, not over black and
// not over a chat. Not over a chat because a timeline behind it would be
// comparing the timeline twice; not over black because the first version did
// exactly that and a black scrim over black is invisible — the native overlay
// was two thirds as dark as the web's for a whole round and this comparison
// reported 1.65% and no scrim difference at all. A flat white behind it is the
// cheapest background that can tell them apart.

let FIXTURE_DEFAULT = "tools/fixtures/hold-states.json"

struct Fixture: Decodable {
    struct Case: Decodable {
        var why: String
        var zone: String
        var phase: String
        var text: String
    }
    var width: CGFloat
    var height: CGFloat
    var gap: CGFloat
    var cases: [Case]
}

@MainActor
func model(_ c: Fixture.Case) -> HoldToTalkModel {
    HoldToTalkModel(zone: HoldZone(rawValue: c.zone) ?? .send,
                    phase: HoldPhase(rawValue: c.phase) ?? .listening,
                    text: c.text,
                    // Both halves draw the resting level. The blob and the dot
                    // scale with the voice, and a still of a moving thing has to
                    // pick one moment; 0 is the only one both sides can agree on
                    // without shipping a waveform in the table.
                    level: 0,
                    // 0:00. The web's clock is a fresh mount each run and its
                    // state starts at zero, so a still can only ever show that
                    // one; the seconds themselves are checked in the fixture
                    // table, where they are cheap.
                    seconds: 0)
}

struct Sheet: View {
    let fixture: Fixture

    var body: some View {
        HStack(alignment: .top, spacing: fixture.gap) {
            ForEach(Array(fixture.cases.enumerated()), id: \.offset) { _, c in
                HoldToTalkView(model: model(c))
                    .frame(width: fixture.width, height: fixture.height)
                    .background(WebContract.background.resolve(.light))
                    .clipped()
            }
        }
        .background(WebContract.background.resolve(.light))
        // The overlay itself is scheme-independent — white-on-dark either way —
        // which is why there is one sheet here and not two. The background under
        // it is the light one because that is the case where a scrim's opacity
        // is visible at all.
        .environment(\.colorScheme, .light)
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
        let path = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : FIXTURE_DEFAULT
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let fixture = try? JSONDecoder().decode(Fixture.self, from: data) else {
            FileHandle.standardError.write("cannot read \(path)\n".data(using: .utf8)!)
            exit(2)
        }
        shoot(Sheet(fixture: fixture), "hold-overlay", outDir)

        // The geometry, printed. These are the numbers the picture is made of,
        // and unlike the picture they can be read in a terminal.
        print("")
        print(String(format: "dome apex      %7.2f above the bottom edge", HoldMetrics.domeApex))
        print(String(format: "band centre    %7.2f at the midline", HoldMetrics.midAt(0)))
        print(String(format: "cap centre     %7.2f at ±%.1f", HoldMetrics.midAt(HoldMetrics.cap), HoldMetrics.cap))
        print(String(format: "label centre   %7.2f at ±%.1f", HoldMetrics.midAt(HoldMetrics.labelD), HoldMetrics.labelD))
        let boxes = HoldCore.hitBoxes(width: fixture.width, height: fixture.height)
        print(String(format: "取消 hit box    %.1f,%.1f → %.1f,%.1f",
                     boxes.cancel.left, boxes.cancel.top, boxes.cancel.right, boxes.cancel.bottom))
        print(String(format: "编辑 hit box    %.1f,%.1f → %.1f,%.1f",
                     boxes.edit.left, boxes.edit.top, boxes.edit.right, boxes.edit.bottom))
    }
}
