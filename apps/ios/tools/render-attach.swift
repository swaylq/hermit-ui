import AppKit
import SwiftUI

// Draws the native attachment strip to PNGs, on this Mac, off the same table
// the web half reads. Not shipped — see tools/render-attach.sh, and
// tools/attach-compare.sh for the pair.
//
// One canvas per scheme, the cases stacked with a fixed gap, so the two images
// are the same size and `png-diff` can subtract them without alignment.

let FIXTURE_DEFAULT = "tools/fixtures/attach-strip.json"

struct Fixture: Decodable {
    struct Chip: Decodable {
        var id: String
        var name: String
        var isImage: Bool
        var kind: String
        var error: String?
        var mimeType: String?
        var width: Int?
        var height: Int?
        var preview: Bool?
    }
    struct Case: Decodable {
        var why: String
        var chips: [Chip]
    }
    var width: CGFloat
    var gap: CGFloat
    /// The thumbnail both sides draw, base64 PNG. Carried IN the table rather
    /// than beside it so there is no way for the two halves to load different
    /// bytes.
    var preview: String
    var cases: [Case]
}

@MainActor
func attachments(_ c: Fixture.Case, preview: Image?) -> [ComposerAttachment] {
    c.chips.map { chip in
        let state: AttachCore.ChipState
        switch chip.kind {
        case "uploading": state = .uploading
        case "error": state = .failed(chip.error ?? "")
        default:
            state = .ready(AttachCore.Ready(isImage: chip.isImage, name: chip.name,
                                            mimeType: chip.mimeType ?? "",
                                            width: chip.width, height: chip.height))
        }
        let shows = (chip.preview ?? false)
        return ComposerAttachment(id: chip.id, name: chip.name, isImage: chip.isImage,
                                  state: state,
                                  previewToken: shows ? chip.id : nil,
                                  preview: shows ? preview : nil)
    }
}

struct StripSheet: View {
    let scheme: ColorScheme
    let fixture: Fixture
    let preview: Image?

    var body: some View {
        VStack(alignment: .leading, spacing: fixture.gap) {
            ForEach(Array(fixture.cases.enumerated()), id: \.offset) { _, c in
                AttachmentStripView(attachments: attachments(c, preview: preview), onRemove: { _ in })
            }
        }
        .frame(width: fixture.width, alignment: .topLeading)
        .background(WebContract.background.resolve(scheme))
        .environment(\.colorScheme, scheme)
        // No `hermitStillFrame` here: nothing in this strip animates or refuses
        // to be drawn by ImageRenderer. That flag lives in SessionRowView for
        // `animate-pulse` and in ComposerView for the TextField it cannot draw.
    }
}

/// Report a child's exact ideal size, to two decimals. `ImageRenderer`'s own
/// `nsImage.size` is rounded UP to whole points, which is a whole point of noise
/// on a number the comparison cares about to a tenth.
struct Measure: Layout {
    var report: (CGSize) -> Void
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let size = subviews.first?.sizeThatFits(.unspecified) ?? .zero
        report(size)
        return size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.minX, y: bounds.minY), anchor: .topLeading,
                              proposal: ProposedViewSize(bounds.size))
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
        var preview: Image?
        if let bytes = Data(base64Encoded: fixture.preview), let ns = NSImage(data: bytes) {
            preview = Image(nsImage: ns)
        }
        shoot(StripSheet(scheme: .dark, fixture: fixture, preview: preview), "attach-strip-dark", outDir)
        shoot(StripSheet(scheme: .light, fixture: fixture, preview: preview), "attach-strip-light", outDir)

        // Each case's own height, so a drift can be named rather than squinted
        // at in a heat map. `HERMIT_MEASURE=1 tools/render-web-attach.sh` prints
        // Chrome's numbers for the same eight, in the same order.
        print("")
        for c in fixture.cases {
            let one = AttachmentStripView(attachments: attachments(c, preview: preview), onRemove: { _ in })
                .frame(width: fixture.width, alignment: .topLeading)
                .environment(\.colorScheme, .dark)
            let r = ImageRenderer(content: one)
            let h = r.nsImage?.size.height ?? 0
            // …and each chip's own box, because a strip that is the right height
            // can still be built out of chips that are the wrong width.
            let widths = attachments(c, preview: preview).prefix(2).map { a -> String in
                var size = CGSize.zero
                let chip = Measure(report: { size = $0 }) {
                    AttachmentChipView(attachment: a, onRemove: {})
                        .environment(\.colorScheme, .dark)
                }
                _ = ImageRenderer(content: chip).nsImage
                return String(format: "%.2fx%.2f", size.width, size.height)
            }
            print(String(format: "%7.2f  [%@]  %@", h, widths.joined(separator: " "), c.why))
        }
    }
}
