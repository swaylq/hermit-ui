import AppKit
import SwiftUI

// Draws the native chat composer to PNGs, on this Mac, with no simulator and no
// server. Not shipped — see tools/render-composer.sh.
//
// Same trick as render-timeline.swift, and the same reason ComposerView.swift is
// pure SwiftUI: round 5 shipped a header whose meta line was laid out wrong in a
// way six assertions could not see and one picture could. The composer's states
// are exactly that kind of thing — a Stop pill beside a send circle is either
// obviously two different controls or it is not, and only a picture says which.
//
// The states are not posed by hand: `placeholder` and `canSend` come out of
// `ComposerCore`, so what the box says here is what it will say on the phone.

let CANVAS_WIDTH: CGFloat = 390          // iPhone 15 / 16 point width

/// One labelled specimen.
struct Case {
    var why: String
    var draft: String
    var model: ComposerModel
}

/// Build a model the way the timeline does — through ComposerCore, never by
/// hand — so a change to the ladder shows up in these pictures.
func model(disabled: Bool = false, working: Bool = false, queueFull: Bool = false,
           awaitingInput: Bool = false, uploading: Int = 0,
           draft: String = "", sending: Bool = false, stopping: Bool = false,
           notice: String? = nil, bottomInset: CGFloat = 0) -> ComposerModel {
    ComposerModel(
        placeholder: ComposerCore.placeholder(ComposerCore.Face(
            disabled: disabled, awaitingInput: awaitingInput, queueFull: queueFull,
            working: working, uploadingCount: uploading, dictating: false,
            touch: true, brainGhost: false
        )),
        canSend: ComposerCore.canSend(disabled: disabled, awaitingInput: awaitingInput,
                                      queueFull: queueFull, uploadingCount: uploading,
                                      draft: draft, readyAttachments: 0),
        sending: sending,
        showStop: ComposerCore.stopPill(inFlight: working, statusKey: "ready", closed: disabled).show,
        stopping: stopping,
        disabled: disabled,
        notice: notice,
        bottomInset: bottomInset
    )
}

let LONG_DRAFT = String(repeating: "\u{7ffb}\u{9875}\u{4e0d}\u{8df3}\u{4f4d} ", count: 24)

let CASES: [Case] = [
    Case(why: "empty and at rest — the circle is dead", draft: "", model: model()),
    Case(why: "typed: the circle lights and the ✕ appears", draft: "把这一屏也做成原生的",
         model: model(draft: "把这一屏也做成原生的")),
    Case(why: "a turn is running: Stop sits BESIDE the circle, never in it",
         draft: "", model: model(working: true)),
    Case(why: "…and the circle still sends, so both can be live at once",
         draft: "queue this one", model: model(working: true, draft: "queue this one")),
    Case(why: "the stop was pressed", draft: "", model: model(working: true, stopping: true)),
    Case(why: "the send is in the air", draft: "", model: model(sending: true)),
    Case(why: "the queue is full — the circle goes dead with text in the box",
         draft: "one too many", model: model(queueFull: true, draft: "one too many")),
    Case(why: "an interaction card upstream owns the turn",
         draft: "", model: model(awaitingInput: true)),
    Case(why: "the session is closed", draft: "", model: model(disabled: true)),
    Case(why: "the send came back refused", draft: "one too many",
         model: model(draft: "one too many", notice: "queue_full")),
    Case(why: "a draft long enough to grow the box — items-end keeps the circle on the last line",
         draft: LONG_DRAFT, model: model(draft: LONG_DRAFT)),
]

struct ComposerStates: View {
    let scheme: ColorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(CASES.enumerated()), id: \.offset) { _, c in
                Text(c.why)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.6))
                    .padding(.horizontal, ComposerMetrics.padH)
                    .padding(.top, 10)
                ComposerView(
                    state: ComposerState(draft: c.draft, model: c.model),
                    onSend: {}, onStop: {}, onClear: {}, onDismissNotice: {}, onDraftChange: { _ in }
                )
            }
        }
        .frame(width: CANVAS_WIDTH, alignment: .topLeading)
        .background(WebContract.background.resolve(scheme))
        .environment(\.colorScheme, scheme)
        // ImageRenderer cannot draw a TextField — see the note in ComposerView.
        .environment(\.hermitStillFrame, true)
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
        shoot(ComposerStates(scheme: .dark), "composer-dark", outDir)
        shoot(ComposerStates(scheme: .light), "composer-light", outDir)

        // What the ladder actually answered, printed so a wrong rung can be
        // named rather than squinted at.
        print("")
        for c in CASES {
            print("\(c.model.canSend ? "send" : "····")  \(c.model.showStop ? "STOP" : "····")  \(c.why)")
            print("        placeholder: \(c.model.placeholder.isEmpty ? "‹empty›" : c.model.placeholder)")
        }
    }
}
