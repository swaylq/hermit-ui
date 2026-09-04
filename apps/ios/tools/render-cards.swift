import AppKit
import SwiftUI

// Renders the Live Activity layouts to PNGs, on this Mac, with no device and no
// live turn. Not shipped — see tools/render-cards.sh.
//
// It exists because an `ActivityViewContext` has no public initialiser: views
// that take one can only be looked at by building, signing, installing and then
// starting a real turn. SessionCardViews.swift is written against a plain
// `SessionCard` for exactly this reason, and this is the thing that cashes it in.
//
// The geometry is an approximation — the real expanded island is laid out around
// the camera cutout by the system, and its exact width and insets are not
// public. What this checks is the part that was wrong the first time: the
// hierarchy, the spacing, whether anything is cramped or stranded.


func sample(_ phase: SessionPhase, line: String, ctx: Int?, queued: Int? = nil, ago: TimeInterval = 9) -> SessionCard {
    SessionCard(
        sessionId: "s1", agentName: "asst", machineName: nil, phase: phase,
        title: "Hermit UI 实时预览", line: line,
        since: Date().addingTimeInterval(-ago), queued: queued, ctxPct: ctx
    )
}

/// The expanded island: two narrow columns beside the cutout, then a full-width
/// band. 370pt is roughly what a 6.1" device gives it.
struct ExpandedMock: View {
    let card: SessionCard
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                IslandLeading(card: card)
                Spacer(minLength: 90)   // the cutout sits here
                IslandTrailing(card: card)
            }
            IslandBottom(card: card, link: nil)
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 14)
        .frame(width: 370, alignment: .leading)
        .background(.black, in: RoundedRectangle(cornerRadius: 42, style: .continuous))
    }
}

struct BannerMock: View {
    let card: SessionCard
    var body: some View {
        SessionBannerBody(card: card)
            .frame(width: 360, alignment: .leading)
            .background(.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

@MainActor func shoot(_ view: some View, _ name: String, _ crab: Image, _ outDir: String) {
    let r = ImageRenderer(
        content: view
            .environment(\.crabImage, crab)
            .environment(\.colorScheme, .dark)
            .padding(10)
            .background(Color(white: 0.12))
    )
    r.scale = 3
    guard let img = r.nsImage, let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    print("wrote \(name).png")
}

@main
enum RenderCards {
    @MainActor static func main() {
        let crabPath = CommandLine.arguments[1]
        let outDir = CommandLine.arguments[2]
        let crab = Image(nsImage: NSImage(contentsOfFile: crabPath) ?? NSImage())
        shoot(ExpandedMock(card: sample(.working, line: "Bash · pnpm --filter dashboard build", ctx: 41)), "expanded-working", crab, outDir)
        shoot(ExpandedMock(card: sample(.blocked, line: "要用 Bash：rm -rf /tmp/hermit-ios-dd", ctx: 78, ago: 240)), "expanded-blocked", crab, outDir)
        shoot(ExpandedMock(card: sample(.blocked, line: "这两个方案你选哪个？A 直接改 db.ts，B 先做离线发件箱", ctx: 55, ago: 95)), "expanded-question", crab, outDir)
        shoot(ExpandedMock(card: sample(.done, line: "回合结束 · 用时 3m 20s", ctx: 93)), "expanded-done", crab, outDir)
        shoot(BannerMock(card: sample(.working, line: "子 agent：盘点 dashboard 所有页面 — 正在读 lib/session-status.ts", ctx: 41, queued: 2)), "banner-working", crab, outDir)
    }
}
