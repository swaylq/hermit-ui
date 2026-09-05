// Drives the Swift port of the chat header's vocabulary over the table the WEB
// produced.
//
//     apps/ios/tools/header-fixture.sh
//
// Every expectation in `tools/fixtures/header-cases.json` came out of running
// the dashboard's own `fmtBytes` / `ctxPct` / `ctxFill` / `contextWindowFor` /
// `runtimeShortLabel` / `providerMark` / `chatHeaderTitle`
// (scripts/gen-header-fixture.ts), so nothing here encodes a belief about what
// the answer should be — a red line is always "the two implementations
// disagree", never "the test author disagrees".
import Foundation

// MARK: - The table

struct Fixture: Decodable {
    struct Bytes: Decodable { var n: Int?; var expected: String }
    struct Pct: Decodable { var tokens: Int?; var total: Int; var pct: Double; var fill: Double }
    struct Window: Decodable { var runtime: String?; var model: String?; var window: Int }
    struct Runtime: Decodable { var kind: String?; var label: String }
    struct Provider: Decodable { var provider: String?; var mark: String? }
    struct Session: Decodable { var title: String?; var preview: String?; var agentName: String? }
    struct Title: Decodable { var why: String; var session: Session?; var sessionId: String; var expected: String }

    var defaultContextWindow: Int
    var codexDefaultWindow: Int
    var kimiDefaultWindow: Int
    var bytes: [Bytes]
    var pct: [Pct]
    var windows: [Window]
    var runtimes: [Runtime]
    var providers: [Provider]
    var titles: [Title]
}

// MARK: - Running it

var checks = 0
var failures: [String] = []

func expect<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    checks += 1
    if got != want { failures.append("\(what)\n      got  \(got)\n      want \(want)") }
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: "\(root)/tools/fixtures/header-cases.json")
guard let data = try? Data(contentsOf: path) else {
    FileHandle.standardError.write("cannot read \(path.path)\n".data(using: .utf8)!)
    exit(2)
}

let fixture: Fixture
do { fixture = try JSONDecoder().decode(Fixture.self, from: data) }
catch { FileHandle.standardError.write("fixture will not decode: \(error)\n".data(using: .utf8)!); exit(2) }

// The constants the table was BUILT with have to be the ones the port reads.
// Without this the two could drift together and agree with nothing else.
expect(WebLabels.defaultContextWindow, fixture.defaultContextWindow, "DEFAULT_CONTEXT_WINDOW")
expect(WebLabels.codexDefaultWindow, fixture.codexDefaultWindow, "CODEX_DEFAULT_WINDOW")
expect(WebLabels.kimiDefaultWindow, fixture.kimiDefaultWindow, "KIMI_DEFAULT_WINDOW")

for c in fixture.bytes {
    expect(WebLabels.fmtBytes(c.n), c.expected, "fmtBytes(\(c.n.map(String.init) ?? "null"))")
}

for c in fixture.pct {
    let pct = WebLabels.ctxPct(c.tokens, total: c.total)
    expect(pct, c.pct, "ctxPct(\(c.tokens.map(String.init) ?? "null"), \(c.total))")
    expect(WebLabels.ctxFill(pct), c.fill, "ctxFill of the same")
    // The colour bands are integer thresholds, so the port is allowed to floor
    // the percentage before asking for a colour — but only if flooring really
    // is equivalent. This is the check that says so, over every case in the
    // table rather than in a comment.
    checks += 1
    let flooredBand = Int(pct.rounded(.down)) >= 90 ? 2 : Int(pct.rounded(.down)) >= 70 ? 1 : 0
    let exactBand = pct >= 90 ? 2 : pct >= 70 ? 1 : 0
    if flooredBand != exactBand {
        failures.append("ctx colour band disagrees once floored at \(pct)")
    }
}

for c in fixture.windows {
    expect(WebLabels.contextWindowFor(runtime: c.runtime, model: c.model), c.window,
           "contextWindowFor(\(c.runtime ?? "null"), \(c.model ?? "null"))")
}

for c in fixture.runtimes {
    expect(WebLabels.runtimeShortLabel(c.kind), c.label, "runtimeShortLabel(\(c.kind ?? "null"))")
}

for c in fixture.providers {
    expect(WebLabels.providerMark(c.provider), c.mark, "providerMark(\(c.provider ?? "null"))")
}

for c in fixture.titles {
    let meta = c.session.map {
        SessionMeta(id: c.sessionId, agentName: $0.agentName ?? "", title: $0.title, preview: $0.preview)
    }
    expect(SessionMeta.headerTitle(meta, sessionId: c.sessionId), c.expected, "chatHeaderTitle[\(c.why)]")
}

// MARK: - Report

print("\(fixture.bytes.count) bytes · \(fixture.pct.count) pct · \(fixture.windows.count) windows · "
      + "\(fixture.runtimes.count) runtimes · \(fixture.providers.count) providers · \(fixture.titles.count) titles")
if failures.isEmpty {
    print("\u{2713} \(checks)/\(checks) checks")
    exit(0)
}
for f in failures { print("  \u{2717} \(f)") }
print("\u{2717} \(checks - failures.count)/\(checks) checks — \(failures.count) failed")
exit(1)
