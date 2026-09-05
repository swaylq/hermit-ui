// Drives the Swift port of the session detail panel over the table the WEB
// produced.
//
//     apps/ios/tools/detail-fixture.sh
//
// Every expectation in `tools/fixtures/detail-cases.json` came out of running
// the dashboard's own `detailPickerView` / `detailSwitchPrompt` /
// `detailSavePayload` / `detailSections` (scripts/gen-detail-fixture.ts), which
// are the functions `session-detail-sheet.tsx` calls — so nothing here encodes
// a belief about what the answer should be. A red line is always "the two
// implementations disagree".
import Foundation

// MARK: - The table

struct Fixture: Decodable {
    struct Card: Decodable, Equatable {
        var id: String
        var label: String
        var blurb: String
        var builtIn: Bool
        var retired: Bool
        var isAgentDefault: Bool
        var credentialId: String?
    }
    struct View: Decodable, Equatable {
        var shownBackend: String
        var shownIsPi: Bool
        var currentMode: String
        var shownMode: String
        var modeBlurb: String?
        var modeSource: String
        var dirty: Bool
        var working: Bool
        var readOnly: Bool
        var inheritedLine: String
        var cards: [Card]
    }
    struct Part: Decodable, Equatable {
        var text: String
        var em: Bool?
    }
    struct Prompt: Decodable, Equatable {
        var title: String
        var message: [Part]
        var confirmLabel: String
        var keepsContext: Bool
    }
    /// Decoded as a raw dictionary so an ABSENT `runtimeMode` is told apart
    /// from an explicit null — the whole point of that key.
    struct Payload: Decodable, Equatable {
        var id: String
        var runtime: String
        var runtimeProvider: String?
        var runtimeModel: String?
        var runtimeMode: String?
        var hasMode: Bool

        enum K: String, CodingKey { case id, runtime, runtimeProvider, runtimeModel, runtimeMode }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            id = try c.decode(String.self, forKey: .id)
            runtime = try c.decode(String.self, forKey: .runtime)
            runtimeProvider = try c.decodeIfPresent(String.self, forKey: .runtimeProvider)
            runtimeModel = try c.decodeIfPresent(String.self, forKey: .runtimeModel)
            runtimeMode = try c.decodeIfPresent(String.self, forKey: .runtimeMode)
            hasMode = c.contains(.runtimeMode)
        }
    }
    struct Form: Decodable {
        var runtime: String?
        var mode: String?
    }
    struct PickerCase: Decodable {
        var why: String
        var session: String
        var cfg: String
        var form: Form
        var scoped: Bool
        var stamp: String?
        var heading: String
        var view: View
        var prompt: Prompt?
        var payload: Payload?
    }
    struct Row: Decodable, Equatable {
        var label: String
        var value: String?
        var mono: Bool?
        var note: String?
        var kind: String?
        var ctxTokens: Int?
        var ctxTotal: Int?
    }
    struct Section: Decodable, Equatable {
        var title: String
        var rows: [Row]
        var footer: String?
    }
    struct SectionCase: Decodable {
        var why: String
        var session: String
        var readOnly: Bool
        var sections: [Section]
    }
    struct Label: Decodable {
        var cfg: String
        var id: String
        var label: String
        var harness: String
    }

    var now: Double
    var sessions: [String: DetailSnapshot?]
    var configs: [String: BackendsConfig?]
    var url: String
    var pickers: [PickerCase]
    var sections: [SectionCase]
    var labels: [Label]
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
let url = URL(fileURLWithPath: "\(root)/tools/fixtures/detail-cases.json")
guard let data = try? Data(contentsOf: url) else {
    FileHandle.standardError.write(Data("cannot read \(url.path)\n".utf8))
    exit(2)
}
let decoder = JSONDecoder()
// The snapshots carry the same ISO-8601-with-milliseconds strings tRPC sends,
// and they are decoded by the SAME parser the app uses — so a date the app
// cannot read fails here rather than showing up as "-" on a phone.
decoder.dateDecodingStrategy = .custom { d in
    let s = try d.singleValueContainer().decode(String.self)
    guard let date = HermitAPI.isoDate(s) else {
        throw DecodingError.dataCorruptedError(in: try d.singleValueContainer(),
                                               debugDescription: "bad date \(s)")
    }
    return date
}
let fx: Fixture
do { fx = try decoder.decode(Fixture.self, from: data) } catch {
    FileHandle.standardError.write(Data("cannot decode fixture: \(error)\n".utf8))
    exit(2)
}
let now = Date(timeIntervalSince1970: fx.now / 1000)

func session(_ key: String) -> DetailSnapshot? { fx.sessions[key] ?? nil }
func config(_ key: String) -> BackendsConfig? { fx.configs[key] ?? nil }

// ── the url the sheet's subtitle prints ─────────────────────────────────────

expect(SessionDetailCore.sessionUrl(origin: "https://hermit.example", sessionId: "s_timeline") == fx.url,
       "sessionUrl", "swift=\(SessionDetailCore.sessionUrl(origin: "https://hermit.example", sessionId: "s_timeline")) web=\(fx.url)")

// ── backendLabelOf / harnessOfBackend ───────────────────────────────────────

for l in fx.labels {
    let cfg = config(l.cfg)
    let got = SessionDetailCore.backendLabel(cfg, l.id)
    expect(got == l.label, "backendLabel(\(l.cfg), \(l.id))", "swift=\(got) web=\(l.label)")
    let h = SessionDetailCore.harnessOfBackend(cfg, l.id)
    expect(h == l.harness, "harnessOfBackend(\(l.cfg), \(l.id))", "swift=\(h) web=\(l.harness)")
}

// ── detailPickerView, and the two things it feeds ───────────────────────────

func described(_ c: DetailBackendCard) -> Fixture.Card {
    Fixture.Card(id: c.id, label: c.label, blurb: c.blurb, builtIn: c.builtIn,
                 retired: c.retired, isAgentDefault: c.isAgentDefault, credentialId: c.credentialId)
}

for c in fx.pickers {
    let d = session(c.session)
    let cfg = config(c.cfg)
    let form = DetailForm(runtime: c.form.runtime, mode: c.form.mode)
    let v = SessionDetailCore.pickerView(d: d, cfg: cfg, form: form, scoped: c.scoped)
    let w = c.view

    expect(SessionDetailCore.stamp(sessionId: "s_timeline", d) == c.stamp, "stamp — \(c.why)",
           "swift=\(String(describing: SessionDetailCore.stamp(sessionId: "s_timeline", d))) web=\(String(describing: c.stamp))")
    expect(SessionDetailCore.heading(d) == c.heading, "heading — \(c.why)")
    expect(v.shownBackend == w.shownBackend, "shownBackend — \(c.why)", "swift=\(v.shownBackend) web=\(w.shownBackend)")
    expect(v.shownIsPi == w.shownIsPi, "shownIsPi — \(c.why)", "swift=\(v.shownIsPi) web=\(w.shownIsPi)")
    expect(v.currentMode == w.currentMode, "currentMode — \(c.why)", "swift=\(v.currentMode) web=\(w.currentMode)")
    expect(v.shownMode == w.shownMode, "shownMode — \(c.why)", "swift=\(v.shownMode) web=\(w.shownMode)")
    expect(v.modeBlurb == w.modeBlurb, "modeBlurb — \(c.why)",
           "swift=\(String(describing: v.modeBlurb)) web=\(String(describing: w.modeBlurb))")
    expect(v.modeSource == w.modeSource, "modeSource — \(c.why)", "swift=\(v.modeSource) web=\(w.modeSource)")
    expect(v.dirty == w.dirty, "dirty — \(c.why)", "swift=\(v.dirty) web=\(w.dirty)")
    expect(v.working == w.working, "working — \(c.why)", "swift=\(v.working) web=\(w.working)")
    expect(v.readOnly == w.readOnly, "readOnly — \(c.why)", "swift=\(v.readOnly) web=\(w.readOnly)")
    expect(v.inheritedLine == w.inheritedLine, "inheritedLine — \(c.why)",
           "swift=\(v.inheritedLine)\n      web=\(w.inheritedLine)")
    // The card ORDER is part of the answer: built-ins first, composed after,
    // and the one the session is on is never missing from the list.
    let got = v.cards.map(described)
    expect(got.map(\.id) == w.cards.map(\.id), "card order — \(c.why)",
           "swift=\(got.map(\.id)) web=\(w.cards.map(\.id))")
    for (g, e) in zip(got, w.cards) where g != e {
        expect(false, "card \(e.id) — \(c.why)", "swift=\(g)\n      web=\(e)")
    }
    expect(got.count == w.cards.count, "card count — \(c.why)", "swift=\(got.count) web=\(w.cards.count)")

    // The confirm and the mutation exist only when there is something to apply.
    if let d, v.dirty {
        guard let wantPrompt = c.prompt, let wantPayload = c.payload else {
            expect(false, "web had no prompt/payload but swift is dirty — \(c.why)"); continue
        }
        let p = SessionDetailCore.switchPrompt(d, cfg, v)
        expect(p.title == wantPrompt.title, "prompt title — \(c.why)", "swift=\(p.title) web=\(wantPrompt.title)")
        expect(p.confirmLabel == wantPrompt.confirmLabel, "prompt confirmLabel — \(c.why)")
        expect(p.keepsContext == wantPrompt.keepsContext, "keepsContext — \(c.why)",
               "swift=\(p.keepsContext) web=\(wantPrompt.keepsContext)")
        let gotParts = p.message.map { Fixture.Part(text: $0.text, em: $0.em ? true : nil) }
        expect(gotParts == wantPrompt.message, "prompt message — \(c.why)",
               "swift=\(gotParts)\n      web=\(wantPrompt.message)")

        let pay = SessionDetailCore.savePayload(d, v)
        expect(pay.id == wantPayload.id, "payload id — \(c.why)")
        expect(pay.runtime == wantPayload.runtime, "payload runtime — \(c.why)",
               "swift=\(pay.runtime) web=\(wantPayload.runtime)")
        expect(pay.runtimeProvider == wantPayload.runtimeProvider, "payload runtimeProvider — \(c.why)")
        expect(pay.runtimeModel == wantPayload.runtimeModel, "payload runtimeModel — \(c.why)")
        // Omitted vs null is the whole rule: a switch AWAY from pi must leave
        // the mode column alone so a switch back finds it.
        expect((pay.runtimeMode != nil) == wantPayload.hasMode, "payload sends runtimeMode? — \(c.why)",
               "swift=\(pay.runtimeMode != nil) web=\(wantPayload.hasMode)")
        expect(pay.runtimeMode == wantPayload.runtimeMode, "payload runtimeMode — \(c.why)",
               "swift=\(String(describing: pay.runtimeMode)) web=\(String(describing: wantPayload.runtimeMode))")
        // And the JSON that actually goes on the wire agrees with the shape.
        if let enc = try? JSONEncoder().encode(pay),
           let obj = try? JSONSerialization.jsonObject(with: enc) as? [String: Any] {
            expect(obj.keys.contains("runtimeMode") == wantPayload.hasMode,
                   "encoded payload key set — \(c.why)",
                   "swift=\(obj.keys.sorted()) webHasMode=\(wantPayload.hasMode)")
        } else {
            expect(false, "payload did not encode — \(c.why)")
        }
    } else {
        expect(c.prompt == nil, "web built a prompt but swift is not dirty — \(c.why)")
    }
}

// ── detailSections ──────────────────────────────────────────────────────────

func described(_ r: DetailRow) -> Fixture.Row {
    Fixture.Row(label: r.label, value: r.value,
                mono: r.mono ? true : nil, note: r.note,
                kind: r.kind == .text ? nil : r.kind.rawValue,
                ctxTokens: r.ctxTokens, ctxTotal: r.ctxTotal)
}

for c in fx.sections {
    guard let d = session(c.session) else { expect(false, "no session \(c.session)"); continue }
    let got = SessionDetailCore.sections(d, readOnly: c.readOnly, now: now)
    expect(got.map(\.title) == c.sections.map(\.title), "section order — \(c.why)",
           "swift=\(got.map(\.title)) web=\(c.sections.map(\.title))")
    for (g, w) in zip(got, c.sections) {
        expect(g.footer == w.footer, "\(w.title) footer — \(c.why)",
               "swift=\(String(describing: g.footer))\n      web=\(String(describing: w.footer))")
        let rows = g.rows.map(described)
        expect(rows.map(\.label) == w.rows.map(\.label), "\(w.title) row labels — \(c.why)",
               "swift=\(rows.map(\.label)) web=\(w.rows.map(\.label))")
        for (gr, wr) in zip(rows, w.rows) where gr != wr {
            expect(false, "\(w.title) row \(wr.label) — \(c.why)", "swift=\(gr)\n      web=\(wr)")
        }
        expect(rows.count == w.rows.count, "\(w.title) row count — \(c.why)",
               "swift=\(rows.count) web=\(w.rows.count)")
    }
    expect(got.count == c.sections.count, "section count — \(c.why)")
}

// ---------------------------------------------------------------------------

if failures == 0 {
    print("detail-fixture: \(checks) assertions, all agree with the web")
} else {
    FileHandle.standardError.write(Data("detail-fixture: \(failures) of \(checks) assertions disagree with the web\n".utf8))
    exit(1)
}
