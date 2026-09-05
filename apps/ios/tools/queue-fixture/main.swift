// Drives the Swift port of the queue strip's decisions over the table the WEB
// produced.
//
//     apps/ios/tools/queue-fixture.sh
//
// Every expectation in `tools/fixtures/queue-cases.json` came out of running
// the dashboard's own `queueDisplay` / `pruneToLive` / `queuePollMs` /
// `queueCancelTarget` / `queueSummary` / `queueItemLabel` / `queueIsFull`
// (scripts/gen-queue-fixture.ts), so nothing here encodes a belief about what
// the answer should be — a red line is always "the two implementations
// disagree", never "the test author disagrees".
import Foundation

// MARK: - The table

struct Fixture: Decodable {
    struct Row: Decodable {
        var id: String
        var content: JSONValue
    }
    struct Stub: Decodable {
        var id: String
        var realId: String?
        var content: JSONValue
    }
    struct Display: Decodable {
        var why: String
        var server: [Row]
        var starters: [String]
        var cancelled: [String]
        var optimistic: [Stub]
        var expected: [String]
    }
    struct Prune: Decodable {
        var why: String
        var ids: [String]
        var live: [String]
        var expected: [String]
    }
    struct Poll: Decodable {
        var why: String
        var inFlight: Bool
        var serverCount: Int
        var expected: Double?
    }
    struct Cancel: Decodable {
        var why: String
        var id: String
        var optimisticIds: [String]
        var expected: String
    }
    struct Summary: Decodable {
        var n: Int
        var expected: String
    }
    struct Label: Decodable {
        var why: String
        var preview: String
        var expected: String
    }
    struct Full: Decodable {
        var n: Int
        var expected: Bool
    }

    var queueLimit: Int
    var pollMs: Double
    var clearLabel: String
    var display: [Display]
    var prune: [Prune]
    var poll: [Poll]
    var cancel: [Cancel]
    var summaries: [Summary]
    var labels: [Label]
    var full: [Full]
}

// MARK: - Running it

var checks = 0
var failures: [String] = []

func expect<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    checks += 1
    if got != want { failures.append("\(what)\n      got  \(got)\n      want \(want)") }
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: "\(root)/tools/fixtures/queue-cases.json")
guard let data = try? Data(contentsOf: path) else {
    FileHandle.standardError.write("cannot read \(path.path)\n".data(using: .utf8)!)
    exit(2)
}

let fixture: Fixture
do { fixture = try JSONDecoder().decode(Fixture.self, from: data) }
catch { FileHandle.standardError.write("fixture will not decode: \(error)\n".data(using: .utf8)!); exit(2) }

// The constants the table was BUILT with have to be the ones the port reads.
expect(QueueCore.limit, fixture.queueLimit, "QUEUE_LIMIT")
expect(QueueCore.pollMs, fixture.pollMs, "QUEUE_POLL_MS")
expect(QueueCore.clearLabel, fixture.clearLabel, "the clear button's label")

// ── queueDisplay ────────────────────────────────────────────────────────────

for c in fixture.display {
    let server = c.server.map { QueueCore.Row(id: $0.id, content: $0.content) }
    let optimistic = c.optimistic.map {
        ComposerCore.Optimistic(id: $0.id, realId: $0.realId, content: $0.content)
    }
    let shown = QueueCore.display(server: server,
                                  starters: Set(c.starters),
                                  cancelled: Set(c.cancelled),
                                  optimistic: optimistic).map(\.id)
    expect(shown, c.expected, "queueDisplay — \(c.why)")
}

// ── pruneToLive ─────────────────────────────────────────────────────────────
//
// Compared SORTED. The web keeps the Set's insertion order and Swift's `Set`
// has no order at all, and neither side's caller reads one: the answer goes
// straight back into a Set on both. Sorting is what makes the comparison honest
// rather than what hides a difference.

for c in fixture.prune {
    let kept = QueueCore.pruneToLive(Set(c.ids), live: c.live).sorted()
    expect(kept, c.expected.sorted(), "pruneToLive — \(c.why)")
}

// ── queuePollMs ─────────────────────────────────────────────────────────────

for c in fixture.poll {
    let got = QueueCore.pollInterval(inFlight: c.inFlight, serverCount: c.serverCount)
    expect(got, c.expected, "queuePollMs — \(c.why)")
}

// ── queueCancelTarget ───────────────────────────────────────────────────────

for c in fixture.cancel {
    let got = QueueCore.cancelTarget(id: c.id, optimisticIds: c.optimisticIds)
    expect(got.rawValue, c.expected, "queueCancelTarget — \(c.why)")
}

// ── the strings, and the rung ───────────────────────────────────────────────

for c in fixture.summaries {
    expect(QueueCore.summary(c.n), c.expected, "queueSummary(\(c.n))")
}
for c in fixture.labels {
    expect(QueueCore.itemLabel(c.preview), c.expected, "queueItemLabel — \(c.why)")
}
for c in fixture.full {
    expect(QueueCore.isFull(c.n), c.expected, "queueIsFull(\(c.n))")
}

// MARK: - Report

if failures.isEmpty {
    print("queue fixture: \(checks) checks, all agree with the web")
    exit(0)
}
print("queue fixture: \(checks) checks, \(failures.count) DISAGREE\n")
for f in failures { print("  ✗ \(f)") }
exit(1)
