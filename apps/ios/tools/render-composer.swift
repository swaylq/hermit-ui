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
    var attachments: [ComposerAttachment] = []
}

// MARK: - Attachment specimens

/// A solid square standing in for a photo. The chip's job is to be 40×40 with
/// the right corner radius and the right opacity; what is inside it is the
/// picker's business, and a recognisable flat colour makes a wrong radius or a
/// wrong grayscale obvious at a glance.
@MainActor func swatch(_ color: NSColor) -> Image {
    let size = NSSize(width: 80, height: 80)
    let img = NSImage(size: size)
    img.lockFocus()
    color.setFill()
    NSRect(origin: .zero, size: size).fill()
    NSColor.white.withAlphaComponent(0.35).setFill()
    NSRect(x: 0, y: 40, width: 80, height: 40).fill()
    img.unlockFocus()
    return Image(nsImage: img)
}

@MainActor func imageChip(_ id: String, _ name: String, _ state: AttachCore.ChipState,
                          _ color: NSColor) -> ComposerAttachment {
    ComposerAttachment(id: id, name: name, isImage: true, state: state,
                       previewToken: id, preview: swatch(color))
}

func fileChip(_ id: String, _ name: String, _ state: AttachCore.ChipState) -> ComposerAttachment {
    ComposerAttachment(id: id, name: name, isImage: false, state: state,
                       previewToken: nil, preview: nil)
}

@MainActor func ready(_ isImage: Bool, _ name: String, _ mime: String,
                      _ w: Int?, _ h: Int?) -> AttachCore.ChipState {
    .ready(AttachCore.Ready(isImage: isImage, name: name, mimeType: mime, width: w, height: h))
}

/// Build a model the way the timeline does — through ComposerCore, never by
/// hand — so a change to the ladder shows up in these pictures.
func model(disabled: Bool = false, working: Bool = false, queueFull: Bool = false,
           awaitingInput: Bool = false, uploading: Int = 0,
           draft: String = "", sending: Bool = false, stopping: Bool = false,
           notice: String? = nil, bottomInset: CGFloat = 0,
           readyAttachments: Int = 0) -> ComposerModel {
    ComposerModel(
        placeholder: ComposerCore.placeholder(ComposerCore.Face(
            disabled: disabled, awaitingInput: awaitingInput, queueFull: queueFull,
            working: working, uploadingCount: uploading, dictating: false,
            touch: true, brainGhost: false
        )),
        canSend: ComposerCore.canSend(disabled: disabled, awaitingInput: awaitingInput,
                                      queueFull: queueFull, uploadingCount: uploading,
                                      draft: draft, readyAttachments: readyAttachments),
        sending: sending,
        showStop: ComposerCore.stopPill(inFlight: working, statusKey: "ready", closed: disabled).show,
        stopping: stopping,
        disabled: disabled,
        notice: notice,
        bottomInset: bottomInset
    )
}

let LONG_DRAFT = String(repeating: "\u{7ffb}\u{9875}\u{4e0d}\u{8df3}\u{4f4d} ", count: 24)

/// The attachment strip's own specimens, drawn under the composer states so a
/// chip can be compared against `tools/render-web-attachments.sh` and against
/// the box it sits above.
@MainActor func attachCases() -> [Case] {
    let long = "2026-09-05-会议纪要-第三次修订-final-v2.markdown"
    return [
        Case(why: "one photo, still uploading — the thumbnail is at 50%",
             draft: "", model: model(uploading: 1),
             attachments: [imageChip("a1", "IMG_4021.jpg", .uploading, .systemTeal)]),
        Case(why: "…landed: the dimensions arrive and the circle lights with an EMPTY box",
             draft: "", model: model(readyAttachments: 1),
             attachments: [imageChip("a1", "IMG_4021.jpg",
                                     ready(true, "IMG_4021.jpg", "image/jpeg", 3024, 4032),
                                     .systemTeal)]),
        Case(why: "a file has no thumbnail, so it gets the plate and the glyph",
             draft: "看看这份", model: model(draft: "看看这份", readyAttachments: 1),
             attachments: [fileChip("f1", "report.pdf",
                                    ready(false, "report.pdf", "application/pdf", nil, nil))]),
        Case(why: "refused before it was ever uploaded — no round trip, no slot",
             draft: "", model: model(),
             attachments: [fileChip("f2", "payload.exe",
                                    .failed(AttachCore.unsupportedTypeError("payload.exe")))]),
        Case(why: "the server said no: the picture stays, greyed, so you know WHICH one",
             draft: "", model: model(),
             attachments: [imageChip("a2", "IMG_4022.heic",
                                     .failed("upload failed (415): unsupported file type"),
                                     .systemPink)]),
        Case(why: "a name too long for max-w-[120px] — it truncates, it does not stretch the chip",
             draft: "", model: model(readyAttachments: 1),
             attachments: [fileChip("f3", long, ready(false, long, "text/markdown", nil, nil))]),
        Case(why: "four of them wrap, and the caption counts both kinds",
             draft: "", model: model(uploading: 1, readyAttachments: 3),
             attachments: [
                imageChip("b1", "one.png", ready(true, "one.png", "image/png", 1290, 2796), .systemBlue),
                imageChip("b2", "two.png", ready(true, "two.png", "image/png", 800, 600), .systemGreen),
                fileChip("b3", "notes.md", ready(false, "notes.md", "text/markdown", nil, nil)),
                imageChip("b4", "three.png", .uploading, .systemOrange),
             ]),
        Case(why: "at the cap: 20/20 goes amber, and the + is still live (a file still fits)",
             draft: "", model: model(readyAttachments: 20),
             attachments: (1...20).map { i in
                imageChip("c\(i)", "IMG_40\(i).jpg",
                          ready(true, "IMG_40\(i).jpg", "image/jpeg", 1200, 1600),
                          [.systemTeal, .systemIndigo, .systemBrown][i % 3])
             }),
        Case(why: "the session is closed: the + greys with everything else",
             draft: "", model: model(disabled: true),
             attachments: [imageChip("d1", "one.png",
                                     ready(true, "one.png", "image/png", 100, 100), .systemGray)]),
    ]
}

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

/// The queue strip, on its own and then under a composer.
///
/// Its labels come out of `QueueCore` for the same reason the composer's do:
/// what a picture says here is what the phone will say. The interesting case is
/// the one that only a picture answers — a queued line long enough to need the
/// ellipsis, beside a ✕ that must not be pushed off the edge.
func queueItems(_ labels: [String]) -> [QueueBarItem] {
    labels.enumerated().map { i, text in
        QueueBarItem(id: "q\(i)", label: QueueCore.itemLabel(text))
    }
}

let LONG_QUEUED = "把队列条也做成原生的，顺便把 dequeue 和 clearQueue 一起接进来，" +
    "这一行故意写得很长，长到必须省略号"

struct QueueCase {
    var why: String
    var model: QueueBarModel
}

let QUEUE_CASES: [QueueCase] = [
    QueueCase(why: "one message waiting", model: QueueBarModel(items: queueItems(["再看一下那个报错"]))),
    QueueCase(why: "three, one of them too long for the line — the ✕ stays put",
              model: QueueBarModel(items: queueItems(["先跑构建", LONG_QUEUED, "然后出图"]))),
    QueueCase(why: "an attachments-only send has no prose to show",
              model: QueueBarModel(items: queueItems(["", "看看这张图"]))),
    QueueCase(why: "full: five is QUEUE_LIMIT, and the composer below says so",
              model: QueueBarModel(items: queueItems(["一", "二", "三", "四", "五"]))),
    QueueCase(why: "清空队列 was pressed — the button is out until the server answers",
              model: QueueBarModel(items: queueItems(["一", "二"]), clearing: true)),
]

struct QueueStates: View {
    let scheme: ColorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(QUEUE_CASES.enumerated()), id: \.offset) { _, c in
                Text(c.why)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.6))
                    .padding(.horizontal, ComposerMetrics.padH)
                    .padding(.top, 10)
                QueueBarView(model: c.model, onCancel: { _ in }, onClear: {})
                    .padding(.bottom, 6)
            }
            Text("the whole bottom of the screen: strip + composer, queue full")
                .font(.system(size: 8, design: .monospaced))
                .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.6))
                .padding(.horizontal, ComposerMetrics.padH)
                .padding(.top, 14)
            ComposerStack(
                state: ComposerState(draft: "这一条发不出去",
                                     model: model(working: true, queueFull: true, draft: "这一条发不出去"),
                                     queue: QUEUE_CASES[3].model),
                onSend: {}, onStop: {}, onClear: {}, onDismissNotice: {},
                onAttach: {}, onRemoveAttachment: { _ in },
                onDraftChange: { _ in }, onCancelQueued: { _ in }, onClearQueue: {}
            )
        }
        .frame(width: CANVAS_WIDTH, alignment: .topLeading)
        .background(WebContract.background.resolve(scheme))
        .environment(\.colorScheme, scheme)
        .environment(\.hermitStillFrame, true)
    }
}

struct AttachStates: View {
    let scheme: ColorScheme
    let cases: [Case]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(cases.enumerated()), id: \.offset) { _, c in
                Text(c.why)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(WebContract.mutedForeground.resolve(scheme).opacity(0.6))
                    .padding(.horizontal, ComposerMetrics.padH)
                    .padding(.top, 10)
                ComposerView(
                    state: ComposerState(draft: c.draft, model: c.model, attachments: c.attachments),
                    onSend: {}, onStop: {}, onClear: {}, onDismissNotice: {},
                    onAttach: {}, onRemoveAttachment: { _ in }, onDraftChange: { _ in }
                )
            }
        }
        .frame(width: CANVAS_WIDTH, alignment: .topLeading)
        .background(WebContract.background.resolve(scheme))
        .environment(\.colorScheme, scheme)
        .environment(\.hermitStillFrame, true)
    }
}

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
                    state: ComposerState(draft: c.draft, model: c.model,
                                         attachments: c.attachments),
                    onSend: {}, onStop: {}, onClear: {}, onDismissNotice: {},
                    onAttach: {}, onRemoveAttachment: { _ in }, onDraftChange: { _ in }
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
        shoot(QueueStates(scheme: .dark), "queue-bar-dark", outDir)
        shoot(QueueStates(scheme: .light), "queue-bar-light", outDir)
        let attach = attachCases()
        shoot(AttachStates(scheme: .dark, cases: attach), "attach-dark", outDir)
        shoot(AttachStates(scheme: .light, cases: attach), "attach-light", outDir)

        // What the ladder actually answered, printed so a wrong rung can be
        // named rather than squinted at.
        print("")
        for c in CASES {
            print("\(c.model.canSend ? "send" : "····")  \(c.model.showStop ? "STOP" : "····")  \(c.why)")
            print("        placeholder: \(c.model.placeholder.isEmpty ? "‹empty›" : c.model.placeholder)")
        }
        print("")
        for c in QUEUE_CASES {
            print("\(QueueCore.isFull(c.model.items.count) ? "FULL" : "····")  \(QueueCore.summary(c.model.items.count))  — \(c.why)")
        }
        print("")
        for c in attach {
            let live = AttachCore.occupiedSlots(c.attachments.map(\.slot))
            let caption = AttachCore.capsCaption(images: live.images, files: live.files)
                .map { $0.text + ($0.atCap ? " «amber»" : "") }
                .joined(separator: AttachCore.capsSeparator)
            print("\(c.model.canSend ? "send" : "····")  \(caption.isEmpty ? "‹no caption›" : caption)  — \(c.why)")
            for a in c.attachments.prefix(4) {
                print("        \(a.name)  →  \(AttachCore.chipSubLabel(a.state))")
            }
        }
    }
}
