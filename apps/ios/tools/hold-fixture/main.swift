// Drives the Swift port of the mic slot, the press-and-hold gesture and the
// dictation text over the table the WEB produced.
//
//     apps/ios/tools/hold-fixture.sh
//
// Every expectation in `tools/fixtures/hold-cases.json` came out of RUNNING the
// dashboard's own `hold-core` / `asr-reduce` / `dictation-text`
// (scripts/gen-hold-fixture.ts), so nothing here encodes a belief about what the
// answer should be — a red line is always "the two implementations disagree",
// never "the test author disagrees".
import Foundation

// MARK: - The table

struct Fixture: Decodable {
    struct Thresholds: Decodable { var holdMs: Double; var bailPx: Double; var slidePx: Double; var pillMinPx: Double }
    struct Geometry: Decodable {
        var drop: Double; var rDome: Double; var rOut: Double; var band: Double
        var cap: Double; var rMid: Double; var zoneH: Double; var labelD: Double
        var domeApex: Double; var pillBottom: Double; var pillHeight: Double
        var pillGutter: Double; var enterMs: Double; var leaveMs: Double
    }
    struct Labels: Decodable { var cancel: String; var edit: String; var auth: String; var authHint: String }
    struct Claim: Decodable, Equatable { var base: String?; var rendered: String }
    struct Rect: Decodable, Equatable { var left: Double; var top: Double; var right: Double; var bottom: Double }

    struct Bail: Decodable { var why: String; var dx: Double; var dy: Double; var expected: Bool }
    struct Zone: Decodable {
        var why: String; var dx: Double; var dy: Double; var x: Double; var y: Double
        var cancel: Rect?; var edit: Rect?; var expected: String
    }
    struct MidAt: Decodable { var d: Double; var expected: Double }
    struct HitBox: Decodable {
        struct Pair: Decodable { var cancel: Rect; var edit: Rect }
        var w: Double; var h: Double; var expected: Pair
    }
    struct Surface: Decodable { var phase: String; var expected: String }
    struct Cancelling: Decodable { var zone: String; var phase: String; var expected: Bool }
    struct Blob: Decodable { var open: Bool; var zone: String; var phase: String; var expected: Bool }
    struct Clock: Decodable { var s: Double; var expected: String }

    struct SlotIn: Decodable {
        var dictating: Bool; var draftLength: Int; var canDictate: Bool
        var disabled: Bool; var awaitingInput: Bool; var micArming: Bool
    }
    struct SlotOut: Decodable, Equatable {
        var slot: String; var listening: Bool?; var spinner: Bool?; var disabled: Bool?
    }
    struct Slot: Decodable { var why: String; var input: SlotIn; var expected: SlotOut }
    struct SlotLabel: Decodable { var dictating: Bool; var expected: String }
    struct LayerIn: Decodable {
        var touch: Bool; var canDictate: Bool; var disabled: Bool; var awaitingInput: Bool
        var dictating: Bool; var draftLength: Int; var focused: Bool; var gestureLive: Bool
    }
    struct Layer: Decodable { var why: String; var input: LayerIn; var expected: Bool }

    struct Join: Decodable { var why: String; var texts: [String]; var expected: String }
    struct Fold: Decodable {
        struct Out: Decodable, Equatable { var draft: String; var claim: Claim }
        var why: String; var claim: Claim; var draft: String; var tail: String; var expected: Out
    }
    struct Replace: Decodable {
        struct Out: Decodable, Equatable { var draft: String; var claim: Claim; var applied: Bool }
        var why: String; var claim: Claim; var draft: String; var tail: String; var expected: Out
    }
    struct Refine: Decodable { var passage: String; var expected: Bool }

    struct Asr: Decodable {
        struct Effect: Decodable, Equatable { var kind: String; var message: String? }
        struct State: Decodable, Equatable { var partial: String; var tail: String; var pending: Int }
        struct Step: Decodable { var raw: String; var changed: Bool; var effect: Effect; var state: State }
        var why: String; var steps: [Step]
    }

    var thresholds: Thresholds
    var geometry: Geometry
    var labels: Labels
    var newClaim: Claim
    var bail: [Bail]
    var zones: [Zone]
    var midAt: [MidAt]
    var hitBoxes: [HitBox]
    var surface: [Surface]
    var cancelling: [Cancelling]
    var blob: [Blob]
    var clock: [Clock]
    var slots: [Slot]
    var slotLabels: [SlotLabel]
    var layers: [Layer]
    var joins: [Join]
    var folds: [Fold]
    var replaces: [Replace]
    var refine: [Refine]
    var asr: [Asr]
}

// MARK: - Running it

var checks = 0
var failures: [String] = []

func expect<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    checks += 1
    if got != want { failures.append("\(what)\n      got  \(got)\n      want \(want)") }
}

/// The geometry is a square root away from the web's, so an exact `==` would be
/// comparing two floating-point pipelines rather than two implementations. A
/// tenth of a MILLIpoint is far below anything that can be drawn and far above
/// the difference between `Math.sqrt` and `squareRoot()`.
func expectClose(_ got: Double, _ want: Double, _ what: String) {
    checks += 1
    if abs(got - want) > 1e-4 { failures.append("\(what)\n      got  \(got)\n      want \(want)") }
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: "\(root)/tools/fixtures/hold-cases.json")
guard let data = try? Data(contentsOf: path) else {
    print("hold fixture: cannot read \(path.path) — run `pnpm --filter @hermit-ui/dashboard gen:hold-fixture`")
    exit(1)
}
let fixture: Fixture
do { fixture = try JSONDecoder().decode(Fixture.self, from: data) }
catch { print("hold fixture: \(path.lastPathComponent) does not decode — \(error)"); exit(1) }

func zone(_ s: String) -> HoldZone { HoldZone(rawValue: s)! }
func phase(_ s: String) -> HoldPhase { HoldPhase(rawValue: s)! }
func rect(_ r: Fixture.Rect?) -> HoldRect? {
    guard let r else { return nil }
    return HoldRect(left: r.left, top: r.top, right: r.right, bottom: r.bottom)
}
func out(_ r: HoldRect) -> Fixture.Rect {
    Fixture.Rect(left: r.left, top: r.top, right: r.right, bottom: r.bottom)
}
func claim(_ c: Fixture.Claim) -> DictationClaim { DictationClaim(base: c.base, rendered: c.rendered) }
func back(_ c: DictationClaim) -> Fixture.Claim { Fixture.Claim(base: c.base, rendered: c.rendered) }

// ── the numbers ─────────────────────────────────────────────────────────────
//
// Constants get a line each because every one of them was measured off a
// screenshot, and a port that quietly rounds 46.5 to 47 draws a different shape
// with no test anywhere to say so.

expect(HoldMetrics.holdMs, fixture.thresholds.holdMs, "HOLD_MS")
expect(Double(HoldMetrics.bailPx), fixture.thresholds.bailPx, "BAIL_PX")
expect(Double(HoldMetrics.slidePx), fixture.thresholds.slidePx, "SLIDE_PX")
expect(Double(HoldMetrics.pillMinPx), fixture.thresholds.pillMinPx, "PILL_MIN_PX")
expect(HoldMetrics.holdDelay, fixture.thresholds.holdMs / 1000, "HOLD_MS in seconds")

let g = fixture.geometry
expect(Double(HoldMetrics.drop), g.drop, "DROP")
expect(Double(HoldMetrics.rDome), g.rDome, "R_DOME")
expect(Double(HoldMetrics.rOut), g.rOut, "R_OUT")
expect(Double(HoldMetrics.band), g.band, "BAND")
expect(Double(HoldMetrics.cap), g.cap, "CAP")
expect(Double(HoldMetrics.rMid), g.rMid, "R_MID")
expect(Double(HoldMetrics.zoneH), g.zoneH, "ZONE_H")
expect(Double(HoldMetrics.labelD), g.labelD, "LABEL_D")
expect(Double(HoldMetrics.domeApex), g.domeApex, "DOME_APEX")
expect(Double(HoldMetrics.pillBottom), g.pillBottom, "PILL_BOTTOM")
expect(Double(HoldMetrics.pillHeight), g.pillHeight, "PILL_HEIGHT")
expect(Double(HoldMetrics.pillGutter), g.pillGutter, "PILL_GUTTER")
expect(HoldMetrics.enterMs, g.enterMs, "ENTER_MS")
expect(HoldMetrics.leaveMs, g.leaveMs, "LEAVE_MS")

expect(HoldCore.cancelLabel, fixture.labels.cancel, "取消")
expect(HoldCore.editLabel, fixture.labels.edit, "编辑")
expect(HoldCore.authLabel, fixture.labels.auth, "the auth bubble")
expect(HoldCore.authHint, fixture.labels.authHint, "the auth hint")
expect(back(DictationClaim.new()), fixture.newClaim, "newClaim()")

// ── the gesture ─────────────────────────────────────────────────────────────

for c in fixture.bail {
    expect(HoldCore.bailed(dx: c.dx, dy: c.dy), c.expected, "holdBailed — \(c.why)")
}
for c in fixture.zones {
    let got = HoldCore.zone(dx: c.dx, dy: c.dy, x: c.x, y: c.y,
                            cancel: rect(c.cancel), edit: rect(c.edit))
    expect(got, zone(c.expected), "holdZoneAt — \(c.why)")
}
for c in fixture.midAt {
    expectClose(Double(HoldMetrics.midAt(c.d)), c.expected, "midAt(\(c.d))")
}
for c in fixture.hitBoxes {
    let got = HoldCore.hitBoxes(width: c.w, height: c.h)
    expect(out(got.cancel), c.expected.cancel, "holdHitBoxes(\(c.w)×\(c.h)) — 取消")
    expect(out(got.edit), c.expected.edit, "holdHitBoxes(\(c.w)×\(c.h)) — 编辑")
}

// ── what the overlay says ───────────────────────────────────────────────────

for c in fixture.surface {
    expect(HoldCore.surfaceLabel(phase(c.phase)), c.expected, "holdSurfaceLabel(\(c.phase))")
}
for c in fixture.cancelling {
    expect(HoldCore.cancelling(zone: zone(c.zone), phase: phase(c.phase)), c.expected,
           "holdCancelling(\(c.zone), \(c.phase))")
}
for c in fixture.blob {
    expect(HoldCore.blobMoving(open: c.open, zone: zone(c.zone), phase: phase(c.phase)), c.expected,
           "holdBlobMoving(open: \(c.open), \(c.zone), \(c.phase))")
}
for c in fixture.clock {
    expect(HoldCore.clock(c.s), c.expected, "holdClock(\(c.s))")
}

// ── the slot ────────────────────────────────────────────────────────────────

func flat(_ s: MicSlot) -> Fixture.SlotOut {
    switch s {
    case .none: return Fixture.SlotOut(slot: "none", listening: nil, spinner: nil, disabled: nil)
    case .clear: return Fixture.SlotOut(slot: "clear", listening: nil, spinner: nil, disabled: nil)
    case let .mic(listening, spinner, disabled):
        return Fixture.SlotOut(slot: "mic", listening: listening, spinner: spinner, disabled: disabled)
    }
}
for c in fixture.slots {
    let got = HoldCore.micSlot(dictating: c.input.dictating,
                               draftLength: c.input.draftLength,
                               canDictate: c.input.canDictate,
                               disabled: c.input.disabled,
                               awaitingInput: c.input.awaitingInput,
                               micArming: c.input.micArming)
    expect(flat(got), c.expected, "micSlot — \(c.why)")
}
for c in fixture.slotLabels {
    expect(HoldCore.micSlotLabel(dictating: c.dictating), c.expected, "micSlotLabel(\(c.dictating))")
}
for c in fixture.layers {
    let i = c.input
    let got = HoldCore.pressLayer(touch: i.touch, canDictate: i.canDictate, disabled: i.disabled,
                                  awaitingInput: i.awaitingInput, dictating: i.dictating,
                                  draftLength: i.draftLength, focused: i.focused,
                                  gestureLive: i.gestureLive)
    expect(got, c.expected, "holdPressLayer — \(c.why)")
}

// ── the words ───────────────────────────────────────────────────────────────

for c in fixture.joins {
    expect(DictationText.joinSegments(c.texts), c.expected, "joinSegments — \(c.why)")
}
for c in fixture.folds {
    let got = DictationText.foldTail(claim(c.claim), draft: c.draft, tail: c.tail)
    expect(Fixture.Fold.Out(draft: got.draft, claim: back(got.claim)), c.expected,
           "foldTail — \(c.why)")
}
for c in fixture.replaces {
    let got = DictationText.replaceTail(claim(c.claim), draft: c.draft, tail: c.tail)
    expect(Fixture.Replace.Out(draft: got.draft, claim: back(got.claim), applied: got.applied),
           c.expected, "replaceTail — \(c.why)")
}
for c in fixture.refine {
    expect(DictationText.worthRefining(c.passage), c.expected, "worthRefining — \(c.passage.debugDescription)")
}

// ── the socket's frames ─────────────────────────────────────────────────────
//
// Each case is a SEQUENCE, and the state after EVERY frame is checked — which is
// the only way the out-of-order correction is a case at all. A port that gets
// frame 4 right by getting frames 1–3 wrong still goes red.

func flat(_ e: AsrEffect) -> Fixture.Asr.Effect {
    switch e {
    case .none: return .init(kind: "none", message: nil)
    case .ready: return .init(kind: "ready", message: nil)
    case .sentence: return .init(kind: "sentence", message: nil)
    case .done: return .init(kind: "done", message: nil)
    case let .fail(m): return .init(kind: "fail", message: m)
    }
}
for c in fixture.asr {
    var m = AsrModel()
    for (i, step) in c.steps.enumerated() {
        let got = AsrReduce.step(m, step.raw)
        let changed = got.model != m
        m = got.model
        let st = AsrReduce.state(m)
        let where_ = "asrStep — \(c.why) [frame \(i + 1): \(step.raw)]"
        expect(flat(got.effect), step.effect, "\(where_) effect")
        expect(Fixture.Asr.State(partial: st.partial, tail: st.tail, pending: st.pending),
               step.state, "\(where_) state")
        // "Did this frame change anything?" is the web's own test for whether to
        // redraw, and a port that quietly rebuilds the model on every frame
        // passes every state check above while redrawing the composer on garbage.
        expect(changed, step.changed, "\(where_) changed")
    }
}

// MARK: - Report

if failures.isEmpty {
    print("hold fixture: \(checks) checks, all agree with the web")
    exit(0)
}
print("hold fixture: \(checks) checks, \(failures.count) DISAGREE\n")
for f in failures { print("  ✗ \(f)") }
exit(1)
