// Drives the Swift ports of `applyMessagePush` / `foldPushes` (TimelineMerge)
// and of `shedRows` / `shouldKeepShed` / `absorbShed` (TimelinePager) over the
// answers the WEB produced.
//
//     apps/ios/tools/merge-fixture.sh
//
// Every expectation in `tools/fixtures/merge-cases.json` came out of calling the
// real functions (scripts/gen-merge-fixture.ts), so nothing here encodes a
// belief about what the answer should be — a red line is always "the two
// implementations disagree", never "the test author disagrees".
//
// The comparison is on whole ROWS re-encoded into the same JSON shape the
// TypeScript emits, not on ids. A check that only looked at ids would pass while
// the phone showed a stale copy of a row that had been re-sent with new content.
import Foundation

// MARK: - Projecting a row back into the web's JSON shape
//
// Lives here rather than in the app: nothing on the phone re-serialises a row.

private func project(_ r: FoldInput) -> JSONValue {
    .object([
        "id": .string(r.id),
        "role": .string(r.role),
        "content": r.content,
        "createdAt": .string(r.createdAt),
        "authoredBy": r.authoredBy.map { JSONValue.string($0) } ?? .null,
    ])
}

private func project(_ rows: [FoldInput]) -> JSONValue { .array(rows.map(project)) }

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

private func strings(_ v: JSONValue?) -> [String] {
    guard case .some(.array(let a)) = v else { return [] }
    return a.compactMap { $0.asString }
}

private func field(_ v: JSONValue?, _ key: String) -> JSONValue? {
    guard case .some(.object(let o)) = v else { return nil }
    return o[key]
}

private func list(_ v: JSONValue?) -> [JSONValue] {
    if case .some(.array(let a)) = v { return a }
    return []
}

private func flag(_ v: JSONValue?) -> Bool {
    if case .some(.bool(let b)) = v { return b }
    return false
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: root).appendingPathComponent("tools/fixtures/merge-cases.json")
guard let data = try? Data(contentsOf: path) else {
    print("\u{2717} cannot read \(path.path) — run `pnpm --filter @hermit-ui/dashboard gen:merge-fixture`")
    exit(1)
}
guard let fixture = try? JSONDecoder().decode(JSONValue.self, from: data) else {
    print("\u{2717} \(path.lastPathComponent) is not JSON")
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

// MARK: - applyMessagePush
//
// `prev` absent and `prev` empty are the same case on this side (`[]`), which is
// itself worth holding: the web distinguishes `undefined` from `[]` in the
// signature and then treats them alike, and a port that only handled one of them
// would pass every test that used the other.

for c in list(field(fixture, "apply")) {
    let name = c.string("name") ?? "?"
    let got = TimelineMerge.apply(inputs(field(c, "prev")),
                                  inputs(field(c, "next")),
                                  gone: strings(field(c, "gone")))
    expect(project(got), field(c, "expected") ?? .null, "apply[\(name)]")
}

// MARK: - foldPushes

for c in list(field(fixture, "fold")) {
    let name = c.string("name") ?? "?"
    let frames = list(field(c, "frames")).map {
        TimelineMerge.Frame(rows: inputs(field($0, "rows")), gone: strings(field($0, "gone")))
    }
    let got = TimelineMerge.fold(inputs(field(c, "base")), frames)
    expect(project(got), field(c, "expected") ?? .null, "fold[\(name)]")
}

// MARK: - shedRows

for c in list(field(fixture, "shed")) {
    let name = c.string("name") ?? "?"
    let got = TimelinePager.shed(inputs(field(c, "prev")), inputs(field(c, "next")))
    expect(project(got), field(c, "expected") ?? .null, "shed[\(name)]")
}

// MARK: - shouldKeepShed

for c in list(field(fixture, "keepShed")) {
    let history = flag(field(c, "historyOnScreen"))
    let tail = flag(field(c, "followingTail"))
    expect(.bool(TimelinePager.shouldKeepShed(historyOnScreen: history, followingTail: tail)),
           field(c, "expected") ?? .null,
           "shouldKeepShed[history=\(history) tail=\(tail)]")
}

// MARK: - absorbShed

for c in list(field(fixture, "absorb")) {
    let name = c.string("name") ?? "?"
    let got = TimelinePager.absorb(inputs(field(c, "rows")), inputs(field(c, "shed")))
    expect(project(got), field(c, "expected") ?? .null, "absorb[\(name)]")
}

// MARK: - the two orderings disagree, and both sides must reproduce that
//
// `merge-messages.ts` parses instants; `use-older-pages.ts` compares ISO
// strings. This section is not asserting that either is right — it pins the
// difference, so neither side can drift and nobody can "tidy" the Swift ports
// into agreeing with each other while the browser still does not.

do {
    let section = field(fixture, "orderSkew")
    let bare = inputs(.array([field(section, "bare") ?? .null]))[0]
    let half = inputs(.array([field(section, "half") ?? .null]))[0]
    let anchor = FoldInput(id: "anchor", role: "assistant", content: .null,
                           createdAt: "2026-08-21T10:00:00.000Z", authoredBy: nil)

    let merged = TimelineMerge.apply([anchor], [half, bare]).map { JSONValue.string($0.id) }
    expect(.array(merged), field(section, "mergeOrder") ?? .null, "orderSkew/mergeOrder")

    let kept = TimelinePager.shed([bare], [half]).map { JSONValue.string($0.id) }
    expect(.array(kept), field(section, "shedKeeps") ?? .null, "orderSkew/shedKeeps")

    // Stated directly as well, so this section fails loudly rather than quietly
    // passing on two empty arrays if the fixture ever loses its teeth.
    checks += 1
    if TimelineMerge.before(bare, half) == TimelinePager.isOlder(bare, half) {
        failures.append("orderSkew: the two orderings now AGREE on the pinned pair — "
                        + "the fixture's claim is stale, regenerate it and rewrite the note")
    }
}

// MARK: - Report

print("\(list(field(fixture, "apply")).count) apply · \(list(field(fixture, "fold")).count) fold · "
      + "\(list(field(fixture, "shed")).count) shed · \(list(field(fixture, "keepShed")).count) keepShed · "
      + "\(list(field(fixture, "absorb")).count) absorb")
if failures.isEmpty {
    print("\u{2713} \(checks)/\(checks) checks")
    exit(0)
}
for f in failures { print("  \u{2717} \(f)") }
print("\u{2717} \(checks - failures.count)/\(checks) checks — \(failures.count) failed")
exit(1)
