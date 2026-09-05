// Drives the Swift port of the chat header's action cluster over the table the
// WEB produced.
//
//     apps/ios/tools/actions-fixture.sh
//
// Every expectation in `tools/fixtures/actions-cases.json` came out of running
// the dashboard's own `headerActions` / `secondaryFolds` / `confirmStep`
// (scripts/gen-actions-fixture.ts), which are the functions `app/chat/page.tsx`
// and `confirm-icon-button.tsx` call — so nothing here encodes a belief about
// what the answer should be. A red line is always "the two implementations
// disagree".
import Foundation

// MARK: - The table

struct Fixture: Decodable {
    struct SessionRow: Decodable {
        var agentName: String?
        var runtime: String?
        var closedAt: String?
        var restartRequestedAt: String?
    }
    struct State: Decodable {
        var session: SessionRow?
        var scoped: Bool
        var creatingChat: Bool
        var deleting: Bool
        var restarting: Bool
        var reopening: Bool
        var findOpen: Bool
        var moreOpen: Bool
        var hasTmuxPane: Bool
    }
    struct Spec: Decodable, Equatable {
        var id: String
        var group: String
        var confirm: Bool
        var confirmLabel: String?
        var danger: Bool
        var disabled: Bool
        var busy: Bool
        var pressed: Bool?
    }
    struct Shape: Decodable {
        var why: String
        var state: State
        var expected: [Spec]
    }
    struct Fold: Decodable {
        var width: Double
        var expected: Bool
    }
    struct Step: Decodable {
        var event: String
        var now: Double
    }
    struct Frame: Decodable {
        var event: String
        var now: Double
        var armed: Bool
        var armedAt: Double?
        var fire: Bool
    }
    struct Run: Decodable {
        var why: String
        var steps: [Step]
        var trace: [Frame]
    }

    var armGuardMs: Double
    var autoDisarmMs: Double
    var secondaryFoldPx: Double
    var shape: [Shape]
    var folds: [Fold]
    var steps: [Run]
}

// MARK: - Runner

var failures = 0
var checks = 0

func expect(_ ok: Bool, _ what: String, _ detail: @autoclosure () -> String = "") {
    checks += 1
    if !ok {
        failures += 1
        let d = detail()
        FileHandle.standardError.write(Data(("  ✗ \(what)" + (d.isEmpty ? "" : "\n      \(d)") + "\n").utf8))
    }
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let url = URL(fileURLWithPath: "\(root)/tools/fixtures/actions-cases.json")
guard let data = try? Data(contentsOf: url) else {
    FileHandle.standardError.write(Data("cannot read \(url.path)\n".utf8))
    exit(2)
}
let fx = try JSONDecoder().decode(Fixture.self, from: data)

// The two timings ARE the confirm's content, so they get their own assertion
// rather than only showing up inside a trace that happens to straddle them.
expect(ConfirmTiming.armGuardMs == fx.armGuardMs, "ARM_GUARD_MS",
       "swift=\(ConfirmTiming.armGuardMs) web=\(fx.armGuardMs)")
expect(ConfirmTiming.autoDisarmMs == fx.autoDisarmMs, "AUTO_DISARM_MS",
       "swift=\(ConfirmTiming.autoDisarmMs) web=\(fx.autoDisarmMs)")
expect(Double(HeaderActions.secondaryFoldPx) == fx.secondaryFoldPx, "SECONDARY_FOLD_PX",
       "swift=\(HeaderActions.secondaryFoldPx) web=\(fx.secondaryFoldPx)")

// ── headerActions ───────────────────────────────────────────────────────────

func swiftState(_ s: Fixture.State) -> HeaderActionState {
    HeaderActionState(
        session: s.session.map {
            HeaderActionState.Session(
                agentName: $0.agentName,
                closed: $0.closedAt != nil,
                restartRequested: $0.restartRequestedAt != nil
            )
        },
        scoped: s.scoped,
        creatingChat: s.creatingChat,
        deleting: s.deleting,
        restarting: s.restarting,
        reopening: s.reopening,
        findOpen: s.findOpen,
        moreOpen: s.moreOpen,
        hasTmuxPane: s.hasTmuxPane
    )
}

func described(_ a: HeaderActionSpec) -> Fixture.Spec {
    Fixture.Spec(id: a.id.rawValue, group: a.group.rawValue, confirm: a.confirm,
                 confirmLabel: a.confirmLabel, danger: a.danger,
                 disabled: a.disabled, busy: a.busy, pressed: a.pressed)
}

for c in fx.shape {
    let got = HeaderActions.specs(swiftState(c.state)).map(described)
    // Order is part of the answer: the cluster reads left to right, and the
    // tray's contents are the `secondary` run in the middle of it.
    let gotIds: [String] = got.map { $0.id }
    let wantIds: [String] = c.expected.map { $0.id }
    expect(gotIds == wantIds, "shape order — \(c.why)", "swift=\(gotIds) web=\(wantIds)")
    for (g, w) in zip(got, c.expected) where g != w {
        expect(false, "spec \(w.id) — \(c.why)", "swift=\(g)\n      web=\(w)")
    }
    // A pass above with different lengths would slip through `zip`.
    expect(got.count == c.expected.count, "shape count — \(c.why)",
           "swift=\(got.count) web=\(c.expected.count)")
}

// The web's `hasTmuxPane` fed the states above; run the Swift copy over the
// same runtimes so the deny-list itself is compared, not just consumed.
for c in fx.shape {
    guard let runtime = c.state.session?.runtime else { continue }
    // `scoped` overrides the pane test on the web, so only compare when it can
    // be read back off the list.
    guard !c.state.scoped else { continue }
    expect(WebLabels.hasTmuxPane(runtime) == c.state.hasTmuxPane,
           "hasTmuxPane(\(runtime))",
           "swift=\(WebLabels.hasTmuxPane(runtime)) web=\(c.state.hasTmuxPane)")
}

// ── secondaryFolds ──────────────────────────────────────────────────────────

for f in fx.folds {
    let got = HeaderActions.secondaryFolds(CGFloat(f.width))
    expect(got == f.expected, "secondaryFolds(\(f.width))", "swift=\(got) web=\(f.expected)")
}

// ── confirmStep ─────────────────────────────────────────────────────────────

for run in fx.steps {
    var state = ConfirmState.disarmed
    for (i, s) in run.steps.enumerated() {
        guard let event = ConfirmEvent(rawValue: s.event) else {
            expect(false, "unknown event \(s.event)"); break
        }
        let out = Confirm.step(state, event, now: s.now)
        state = out.state
        let want = run.trace[i]
        expect(out.state.armed == want.armed, "step \(i) armed — \(run.why)",
               "swift=\(out.state.armed) web=\(want.armed)")
        // `armedAt` is only meaningful while armed; the web writes null once it
        // is not, and comparing a stale Swift timestamp against that would be a
        // false red.
        if want.armed {
            expect(out.state.armedAt == (want.armedAt ?? -1), "step \(i) armedAt — \(run.why)",
                   "swift=\(out.state.armedAt) web=\(String(describing: want.armedAt))")
        }
        expect(out.fire == want.fire, "step \(i) fire — \(run.why)",
               "swift=\(out.fire) web=\(want.fire)")
    }
}

// ---------------------------------------------------------------------------

if failures == 0 {
    print("actions-fixture: \(checks) assertions, all agree with the web")
} else {
    FileHandle.standardError.write(Data("actions-fixture: \(failures)/\(checks) FAILED\n".utf8))
    exit(1)
}
