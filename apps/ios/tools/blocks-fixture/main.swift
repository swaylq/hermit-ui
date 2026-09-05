// Drives the Swift port of `parseBlock` / `parseBlocks` over the table the WEB
// produced.
//
//     apps/ios/tools/blocks-fixture.sh
//
// Every expectation in `tools/fixtures/block-cases.json` came out of running
// `apps/dashboard/src/lib/chat-blocks.ts` (scripts/gen-blocks-fixture.ts), so
// nothing here encodes a belief about what the answer should be — a red line is
// always "the two implementations disagree", never "the test author disagrees".
//
// The comparison is on the whole normalised block, re-encoded into the SAME JSON
// shape the TypeScript emits, rather than on a field or two. Half of what makes
// these two agree is which fields are null and which are absent, and a check
// that only looked at the tag would pass while the phone drew the wrong picture.
import Foundation

// MARK: - Projecting a ContentBlock back into the web's JSON shape
//
// Lives here rather than in `Hermit/ContentBlock.swift` because the app never
// needs it: nothing on the phone re-serialises a block. It is the fixture's
// business alone.

private func j(_ s: String?) -> JSONValue { s.map { .string($0) } ?? .null }
private func j(_ d: Double?) -> JSONValue { d.map { .number($0) } ?? .null }

private func project(_ source: MediaSourceView) -> JSONValue {
    .object([
        "kind": .string(source.kind.rawValue),
        "url": j(source.url),
        "mediaType": j(source.mediaType),
        "data": j(source.data),
        "elidedKB": j(source.elidedKB),
    ])
}

private func project(_ block: ContentBlock) -> JSONValue {
    switch block {
    case .text(let b):
        return .object(["type": .string("text"), "text": .string(b.text)])
    case .thinking(let b):
        return .object([
            "type": .string("thinking"),
            "thinking": .string(b.thinking),
            "chars": .number(Double(b.chars)),
            "digested": .bool(b.digested),
        ])
    case .toolUse(let b):
        return .object([
            "type": .string("tool_use"),
            "id": .string(b.id),
            "name": .string(b.name),
            "input": b.input,
            "digested": .bool(b.digested),
        ])
    case .toolResult(let b):
        return .object([
            "type": .string("tool_result"),
            "toolUseId": .string(b.toolUseId),
            "content": b.content,
            "isError": .bool(b.isError),
            "digested": .bool(b.digested),
        ])
    case .image(let b):
        return .object([
            "type": .string("image"),
            "source": project(b.source),
            "width": j(b.width),
            "height": j(b.height),
        ])
    case .file(let b):
        return .object([
            "type": .string("file"),
            "source": project(b.source),
            "name": j(b.name),
        ])
    case .interaction(let b):
        return .object([
            "type": .string("interaction"),
            "interactionId": j(b.interactionId),
            "kind": .string(b.kind.rawValue),
            "payload": b.payload,
            "status": .string(b.status.rawValue),
            "decision": b.decision,
            "answeredBy": j(b.answeredBy),
        ])
    case .unknown(let type, let raw):
        return .object(["type": .string("unknown"), "blockType": .string(type), "raw": raw])
    }
}

// MARK: - The table

struct BlockCase: Decodable {
    var name: String
    var block: JSONValue
    var expected: JSONValue
}

struct ContentCase: Decodable {
    var name: String
    var content: JSONValue
    var expected: [JSONValue]
}

struct Fixture: Decodable {
    var digestFlag: String
    var blocks: [BlockCase]
    var contents: [ContentCase]
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: root).appendingPathComponent("tools/fixtures/block-cases.json")
guard let data = try? Data(contentsOf: path) else {
    print("\u{2717} cannot read \(path.path) — run `pnpm --filter @hermit-ui/dashboard gen:blocks-fixture`")
    exit(1)
}
let fixture: Fixture
do {
    fixture = try JSONDecoder().decode(Fixture.self, from: data)
} catch {
    print("\u{2717} \(path.lastPathComponent) did not decode: \(error)")
    exit(1)
}

// MARK: - Report helpers

var checks = 0
var failures: [String] = []

/// Pretty JSON, sorted, so a diff line reads the same on both sides.
func show(_ v: JSONValue) -> String {
    let enc = JSONEncoder()
    enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let d = try? enc.encode(v), let s = String(data: d, encoding: .utf8) else { return "<unencodable>" }
    return s
}

func expect(_ got: JSONValue, _ want: JSONValue, _ what: String) {
    checks += 1
    guard got != want else { return }
    failures.append("\(what)\n      web:   \(show(want))\n      swift: \(show(got))")
}

// MARK: - The two functions under test

// The `__d` flag is a string constant on both sides; a rename on one of them
// would silently stop marking blocks as digested, and every digested block would
// then claim to carry a body it does not have.
checks += 1
if fixture.digestFlag != ContentBlock.digestFlag {
    failures.append("digestFlag: web \(fixture.digestFlag) vs swift \(ContentBlock.digestFlag)")
}

for c in fixture.blocks {
    expect(project(ContentBlock.parse(c.block)), c.expected, "parseBlock[\(c.name)]")
}

for c in fixture.contents {
    let got = ContentBlock.parseAll(c.content).map(project)
    expect(.array(got), .array(c.expected), "parseBlocks[\(c.name)]")

    // The bytes path is what the app will really use — a `content` field pulled
    // straight out of a tRPC response — and it must land on the same blocks as
    // the already-parsed value.
    if let raw = try? JSONEncoder().encode(c.content) {
        let fromBytes = ContentBlock.parseAll(json: raw).map(project)
        expect(.array(fromBytes), .array(got), "parseBlocks(json:)[\(c.name)]")
    }
}

// A block that decodes is not the same as a block that RENDERS, and `text` is
// the one accessor the timeline reaches for on every row. Only prose counts:
// joining anything else in is what would let a search match run across a block
// boundary (server/chat-text.ts).
let prose = ContentBlock.parseAll(.array([
    .object(["type": .string("text"), "text": .string("hello")]),
    .object(["type": .string("thinking"), "thinking": .string("hm")]),
    .object(["type": .string("wat")]),
])).map(\.text)
expect(.array(prose.map { .string($0) }), .array([.string("hello"), .string(""), .string("")]),
       "ContentBlock.text")

// MARK: - Report

print("\(fixture.blocks.count) blocks · \(fixture.contents.count) contents")
if failures.isEmpty {
    print("\u{2713} \(checks)/\(checks) checks")
    exit(0)
}
for f in failures { print("  \u{2717} \(f)") }
print("\u{2717} \(checks - failures.count)/\(checks) checks — \(failures.count) failed")
exit(1)
