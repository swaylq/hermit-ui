import AppKit
import SwiftUI

// Draws the native session detail panel to PNGs, on this Mac, with no
// simulator, no signing and no server. Not shipped — see tools/render-detail.sh.
//
// The same trick render-list.swift plays on the sidebar. It works here because
// SessionDetailView is SwiftUI over `SessionDetailCore`'s answer and a model
// that can be handed a snapshot instead of a key: nothing on this path opens a
// socket, so the states worth looking at are posed rather than fished for.
//
// The states are the ones the panel can actually be in — loading, gone, a live
// claude session, a pi session mid-edit, one with background work outstanding,
// and a share link — each in both schemes.

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "shots"

/// 1600pt tall so a whole panel fits in one image, and scale 1.2 so the result
/// is 1920px on its long edge. An image over 2000px wedges the session that
/// tries to read it (agents/asst/AGENTS.md), which is the only reason this is
/// not the scale 3 the other renderers use.
let scale: CGFloat = 1.2
let size = CGSize(width: 390, height: 1600)

@MainActor
func render<V: View>(_ view: V, _ name: String, scheme: ColorScheme) {
    let r = ImageRenderer(content:
        view
            .environment(\.colorScheme, scheme)
            .frame(width: size.width, height: size.height)
            .background(WebContract.popover.resolve(scheme))
    )
    r.scale = scale
    guard let img = r.nsImage, let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return }
    try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
    print("wrote \(name).png")
}

// ── the states ──────────────────────────────────────────────────────────────

// This process's clock, because the panel formats its own "ago" against
// `Date()` — a fixture with a baked-in epoch prints "future" on every row.
let now = Date()
func ago(_ s: Double) -> Date { now.addingTimeInterval(-s) }

func backend(_ id: String, _ harness: String, model: String? = nil, mode: String? = nil,
             cred: String? = nil) -> DetailBackend {
    DetailBackend(backendId: id, runtime: harness, runtimeModel: model,
                  runtimeMode: mode, runtimeCredentialId: cred)
}

func snapshot(state: String? = "idle",
              backendOn: DetailBackend = backend("claude-sdk", "claude-sdk", model: "claude-opus-4-6"),
              agentOn: DetailBackend = backend("claude-sdk", "claude-sdk"),
              inherited: Bool = true,
              activity: SessionActivity? = nil,
              closed: Bool = false,
              mode: String? = nil) -> DetailSnapshot {
    DetailSnapshot(
        id: "s_timeline", agentName: "asst", title: "the ios port", titleAuto: false,
        origin: closed ? "cron" : nil,
        startedAt: ago(86_400 * 3), lastMessageAt: ago(45), lastActivity: ago(12),
        closedAt: closed ? ago(600) : nil, hiddenAt: nil, hibernatedAt: nil,
        snapshotAt: ago(3_600),
        runtimeProvider: nil, runtimeModel: nil, runtimeMode: mode,
        claudeSessionId: "a1b2c3d4-0000-4000-8000-000000000001",
        transcriptPath: "/Users/z/.claude/projects/asst/a1b2c3d4.jsonl",
        agentDirectory: "/Users/z/agents/asst",
        pid: 4711, alive: true, state: state, rssMb: 812,
        activity: activity, contextTokens: 512_000, messageCount: 318, groupName: nil,
        backend: backendOn, agentBackend: agentOn, inherited: inherited
    )
}

let composed = BackendsConfig(
    disabled: [],
    instances: [BackendInstance(id: "pi-home", harness: "pi-rpc", credentialId: "cred-dsk",
                                label: "pi (home)", model: nil, mode: "coding")],
    dshSource: nil
)

@MainActor
func model(_ d: DetailSnapshot?, cfg: BackendsConfig? = BackendsConfig(disabled: []),
           form: DetailForm = .empty, scoped: Bool = false,
           loading: Bool = false, gone: Bool = false) -> SessionDetailModel {
    let m = SessionDetailModel(sessionId: "s_timeline", scoped: scoped)
    m.pose(detail: d, config: cfg, form: form, loading: loading, gone: gone)
    m.url = "http://192.168.2.54:3000/chat?session=s_timeline"
    return m
}

let bg = SessionActivity(
    kind: "background",
    backgroundCount: 2,
    backgroundTasks: [
        .init(id: "bg1", description: "pnpm build", elapsedSec: 5_280),
        .init(id: "bg2", description: "du -sh ~/Library", elapsedSec: 88),
    ]
)

@main
enum Main {
    @MainActor static func main() {
        for scheme in [ColorScheme.light, .dark] {
            let tag = scheme == .dark ? "dark" : "light"
            func shoot(_ m: SessionDetailModel, _ name: String) {
                render(SessionDetailView(model: m, scrolls: false), "\(name)-\(tag)", scheme: scheme)
            }
            shoot(model(nil, loading: true), "detail-loading")
            shoot(model(nil, gone: true), "detail-gone")
            shoot(model(snapshot()), "detail-claude")
            shoot(model(snapshot(state: "working",
                                 backendOn: backend("pi-home", "pi-rpc", mode: "ops", cred: "cred-dsk"),
                                 agentOn: backend("claude-sdk", "claude-sdk"),
                                 inherited: false, mode: "ops"),
                        cfg: composed), "detail-pi-working")
            shoot(model(snapshot(backendOn: backend("codex-exec", "codex-exec", model: "gpt-5-codex"),
                                 agentOn: backend("codex-exec", "codex-exec")),
                        cfg: composed, form: DetailForm(runtime: "pi-home", mode: "patch")),
                  "detail-dirty")
            shoot(model(snapshot(activity: bg)), "detail-background")
            shoot(model(snapshot(closed: true), scoped: true), "detail-shared")
        }
    }
}
