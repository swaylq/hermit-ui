// Drives the Swift port of `foldRuns` over the rows the WEB produced.
//
//     apps/ios/tools/fold-fixture.sh
//
// Every expectation in `tools/fixtures/fold-cases.json` came out of running
// `apps/dashboard/src/components/chat/fold-runs.ts`
// (scripts/gen-fold-fixture.ts), so nothing here encodes a belief about what the
// answer should be — a red line is always "the two implementations disagree",
// never "the test author disagrees".
//
// The comparison is on whole rows, re-encoded into the SAME JSON shape the
// TypeScript emits: kind, key, ids, role, the blocks that landed in the row, the
// steps that landed in the capsule, and the capsule's summary. A check that only
// looked at the row kinds would pass while the phone drew the wrong conversation.
import Foundation

// MARK: - Projecting a folded row back into the web's JSON shape
//
// Lives here rather than in `Hermit/FoldRuns.swift` because the app never needs
// it: nothing on the phone re-serialises a row.

private func project(_ step: RunStep) -> JSONValue {
    switch step {
    case .call(let c):
        return .object(["t": .string("call"), "id": .string(c.id), "name": .string(c.name),
                        "input": c.input, "d": .bool(c.digested)])
    case .result(let block, let d):
        return .object(["t": .string("result"), "block": block, "d": .bool(d)])
    case .think(let text, let chars):
        return .object(["t": .string("think"), "text": .string(text), "chars": .number(Double(chars))])
    }
}

private func project(_ s: RunSummary) -> JSONValue {
    let last: JSONValue = s.last.map {
        .object(["id": .string($0.id), "name": .string($0.name), "input": $0.input, "d": .bool($0.digested)])
    } ?? .null
    return .object([
        "names": .array(s.names.map { .string($0) }),
        "calls": .number(Double(s.calls)),
        "errors": .number(Double(s.errors)),
        "thinkChars": .number(Double(s.thinkChars)),
        "last": last,
        "digested": .bool(s.digested),
    ])
}

private func project(_ row: FoldedRow) -> JSONValue {
    switch row {
    case .end(let e):
        return .object(["kind": .string("end"), "key": .string(e.key),
                        "ids": .array(e.ids.map { .string($0) }), "createdAt": .string(e.createdAt)])
    case .msg(let m):
        return .object([
            "kind": .string("msg"),
            "key": .string(m.key),
            "ids": .array(m.ids.map { .string($0) }),
            "role": .string(m.role),
            "authoredBy": m.authoredBy.map { JSONValue.string($0) } ?? .null,
            "blocks": .array(m.rawBlocks),
            // Ties the fold to the other ported function: the phone renders
            // these through `ContentBlock.parse`.
            "blockKinds": .array(m.blocks.map { .string($0.kind) }),
            "createdAt": .string(m.createdAt),
            "msgId": .string(m.msgId),
        ])
    case .run(let r):
        return .object([
            "kind": .string("run"),
            "key": .string(r.key),
            "ids": .array(r.ids.map { .string($0) }),
            "from": .string(r.from),
            "to": .string(r.to),
            "steps": .array(r.steps.map(project)),
            "summary": project(FoldRuns.summarize(r.steps)),
        ])
    }
}

/// Exactly what a reader sees with nothing expanded — the projection the digest
/// claim is made about. Mirrors `collapsed` in the generator.
private func collapsed(_ rows: [FoldedRow]) -> JSONValue {
    .array(rows.map { row in
        guard case .object(var o) = project(row) else { return .null }
        o.removeValue(forKey: "steps")
        if case .some(.object(let s)) = o["summary"] {
            var name: JSONValue = .null
            if case .some(.object(let l)) = s["last"] { name = l["name"] ?? .null }
            o["summary"] = .object([
                "names": s["names"] ?? .null, "calls": s["calls"] ?? .null,
                "errors": s["errors"] ?? .null, "thinkChars": s["thinkChars"] ?? .null,
                "last": name,
            ])
        }
        if case .some(.array(let blocks)) = o["blocks"] {
            o["blocks"] = .array(blocks.map { b in
                guard case .object(let bo) = b else { return .object(["t": .null]) }
                if bo["type"] == .string("text") {
                    return .object(["t": .string("text"), "text": bo["text"] ?? .null])
                }
                return .object(["t": bo["type"] ?? .null])
            })
        }
        return .object(o)
    })
}

// MARK: - Reading the table

private func inputs(_ v: JSONValue?) -> [FoldInput] {
    guard case .some(.array(let items)) = v else { return [] }
    return items.map { item in
        FoldInput(id: item.string("id") ?? "",
                  role: item.string("role") ?? "",
                  content: { if case .object(let o) = item { return o["content"] ?? .null }; return .null }(),
                  createdAt: item.string("createdAt") ?? "",
                  authoredBy: item.string("authoredBy"))
    }
}

private func field(_ v: JSONValue?, _ key: String) -> JSONValue? {
    guard case .some(.object(let o)) = v else { return nil }
    return o[key]
}

private func list(_ v: JSONValue?) -> [JSONValue] {
    if case .some(.array(let a)) = v { return a }
    return []
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: root).appendingPathComponent("tools/fixtures/fold-cases.json")
guard let data = try? Data(contentsOf: path) else {
    print("\u{2717} cannot read \(path.path) — run `pnpm --filter @hermit-ui/dashboard gen:fold-fixture`")
    exit(1)
}
guard let fixture = try? JSONDecoder().decode(JSONValue.self, from: data) else {
    print("\u{2717} \(path.lastPathComponent) is not JSON")
    exit(1)
}

// `isSameDay` asks the LOCAL calendar, so the two sides can only be compared
// under one zone. The generator pinned UTC; if this process is not in it, every
// day-boundary row below would be answering a different question.
if TimeZone.current.secondsFromGMT() != 0 {
    print("\u{2717} run this under TZ=UTC (fixture says \(fixture.string("timezone") ?? "?"), "
          + "this process is \(TimeZone.current.identifier))")
    exit(1)
}

var checks = 0
var failures: [String] = []

func show(_ v: JSONValue) -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let d = try? enc.encode(v), let s = String(data: d, encoding: .utf8) else { return "<unencodable>" }
    return s.count > 900 ? String(s.prefix(900)) + "…" : s
}

func expect(_ got: JSONValue, _ want: JSONValue, _ what: String) {
    checks += 1
    guard got != want else { return }
    failures.append("\(what)\n      web:   \(show(want))\n      swift: \(show(got))")
}

// MARK: - The constant

checks += 1
if fixture.string("openRunKey") != FoldRuns.openRunKey {
    failures.append("openRunKey: web \(fixture.string("openRunKey") ?? "?") vs swift \(FoldRuns.openRunKey)")
}

// MARK: - isMachineryBlock

for c in list(field(fixture, "machinery")) {
    let name = c.string("name") ?? "?"
    expect(.bool(FoldRuns.isMachineryBlock(field(c, "block") ?? .null)),
           field(c, "expected") ?? .null, "isMachineryBlock[\(name)]")
}

// MARK: - isHarnessTerminator

for c in list(field(fixture, "terminators")) {
    let name = c.string("name") ?? "?"
    expect(.bool(FoldRuns.isHarnessTerminator(field(c, "content") ?? .null)),
           field(c, "expected") ?? .null, "isHarnessTerminator[\(name)]")
}

// MARK: - closesRunUnconditionally

for c in list(field(fixture, "seams")) {
    let name = c.string("name") ?? "?"
    let m = inputs(.array([field(c, "message") ?? .null]))[0]
    expect(.bool(FoldRuns.closesRunUnconditionally(m)), field(c, "expected") ?? .null,
           "closesRunUnconditionally[\(name)]")
}

// MARK: - safeSplitIndex

for c in list(field(fixture, "splits")) {
    let name = c.string("name") ?? "?"
    let ms = inputs(field(c, "messages"))
    let at = Int(field(c, "at")?.asDouble ?? 0)
    expect(.number(Double(FoldRuns.safeSplitIndex(ms, at: at))), field(c, "expected") ?? .null,
           "safeSplitIndex[\(name)]")
}

// MARK: - foldRuns

for c in list(field(fixture, "folds")) {
    let name = c.string("name") ?? "?"
    let rows = FoldRuns.fold(inputs(field(c, "messages")))
    expect(.array(rows.map(project)), field(c, "expected") ?? .null, "foldRuns[\(name)]")
}

// MARK: - the seam property
//
// Folding in two halves at any safe seam must give exactly the rows folding the
// whole gives. This is what makes the incremental fold legal; if it stops
// holding, a long session silently renders differently from a short one.

do {
    let section = field(fixture, "seamIdentity")
    let messages = inputs(field(section, "messages"))
    let whole = FoldRuns.fold(messages).map(project)
    expect(.array(whole), field(section, "expected") ?? .null, "seamIdentity/whole")

    var seams = 0
    for at in 1..<max(messages.count, 2) {
        let cut = FoldRuns.safeSplitIndex(messages, at: at)
        guard cut != 0 else { continue }
        seams += 1
        let split = FoldRuns.fold(Array(messages[0..<cut])).map(project)
            + FoldRuns.fold(Array(messages[cut...])).map(project)
        expect(.array(split), .array(whole), "seamIdentity/split-at-\(cut)")
    }
    // The web counted the seams in this list. A port that found none would
    // otherwise pass this section by doing nothing at all.
    expect(.number(Double(seams)), field(section, "seams") ?? .null, "seamIdentity/seam-count")
}

// MARK: - the digest must be invisible until someone clicks
//
// The collapsed rows on the right are the web's, folded from the FULL content.
// The messages on the left are the same conversation after the digest dropped
// every body it could. A reader with nothing expanded must not be able to tell.

do {
    let section = field(fixture, "digestInvariance")
    let rows = FoldRuns.fold(inputs(field(section, "messages")))
    expect(collapsed(rows), field(section, "expectedCollapsed") ?? .null, "digestInvariance")
}

// MARK: - Report

print("\(list(field(fixture, "folds")).count) folds · \(list(field(fixture, "machinery")).count) machinery · "
      + "\(list(field(fixture, "terminators")).count) terminators · \(list(field(fixture, "seams")).count) seams · "
      + "\(list(field(fixture, "splits")).count) splits")
if failures.isEmpty {
    print("\u{2713} \(checks)/\(checks) checks")
    exit(0)
}
for f in failures { print("  \u{2717} \(f)") }
print("\u{2717} \(checks - failures.count)/\(checks) checks — \(failures.count) failed")
exit(1)
