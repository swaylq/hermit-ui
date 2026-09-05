// Drives the Swift port of the composer's decisions over the table the WEB
// produced.
//
//     apps/ios/tools/composer-fixture.sh
//
// Every expectation in `tools/fixtures/composer-cases.json` came out of running
// the dashboard's own `dropLanded` / `composerPlaceholder` / `composerCanSend` /
// `turnInFlight` / `stopPill` and its `CLIENT_ID_RE`
// (scripts/gen-composer-fixture.ts), so nothing here encodes a belief about what
// the answer should be — a red line is always "the two implementations
// disagree", never "the test author disagrees".
import Foundation

// MARK: - The table

struct Fixture: Decodable {
    struct Opt: Decodable {
        var id: String
        var realId: String?
        var content: JSONValue
    }
    struct Real: Decodable {
        var id: String
        var content: JSONValue
    }
    struct Landed: Decodable {
        var why: String
        var optimistic: [Opt]
        var real: [Real]
        var kept: [String]
    }
    struct Face: Decodable {
        var disabled: Bool
        var awaitingInput: Bool
        var queueFull: Bool
        var working: Bool
        var uploadingCount: Int
        var dictating: Bool
        var touch: Bool
        var brainGhost: Bool
    }
    struct Placeholder: Decodable {
        var why: String
        var face: Face
        var expected: String
    }
    struct SendInput: Decodable {
        var disabled: Bool
        var awaitingInput: Bool
        var queueFull: Bool
        var uploadingCount: Int
        var draft: String
        var readyAttachments: Int
    }
    struct CanSend: Decodable {
        var why: String
        var input: SendInput
        var expected: Bool
    }
    struct Signals: Decodable {
        var statusState: String?
        var snapshotAt: Double?
        var lastRole: String?
        var lastAt: Double?
        var optimisticAt: Double?
        var streamingTail: Bool
        var now: Double
    }
    struct FlightExpectation: Decodable {
        var waitingAssistant: Bool
        var inFlight: Bool
    }
    struct FlightCase: Decodable {
        var why: String
        var input: Signals
        var expected: FlightExpectation
    }
    struct StopExpectation: Decodable {
        var turnRunning: Bool
        var show: Bool
    }
    struct StopCase: Decodable {
        var why: String
        var inFlight: Bool
        var statusKey: String
        var closed: Bool
        var expected: StopExpectation
    }
    struct ClientId: Decodable {
        var why: String
        var id: String
        var ok: Bool
    }

    var queueLimit: Int
    var deliveryGraceMs: Double
    var clientIdPattern: String
    var landed: [Landed]
    var placeholders: [Placeholder]
    var canSend: [CanSend]
    var flight: [FlightCase]
    var stop: [StopCase]
    var clientIds: [ClientId]
}

// MARK: - Running it

var checks = 0
var failures: [String] = []

func expect<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    checks += 1
    if got != want { failures.append("\(what)\n      got  \(got)\n      want \(want)") }
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: "\(root)/tools/fixtures/composer-cases.json")
guard let data = try? Data(contentsOf: path) else {
    FileHandle.standardError.write("cannot read \(path.path)\n".data(using: .utf8)!)
    exit(2)
}

let fixture: Fixture
do { fixture = try JSONDecoder().decode(Fixture.self, from: data) }
catch { FileHandle.standardError.write("fixture will not decode: \(error)\n".data(using: .utf8)!); exit(2) }

// The constants the table was BUILT with have to be the ones the port reads.
// Without this the two could drift together and agree with nothing else.
expect(ComposerCore.queueLimit, fixture.queueLimit, "QUEUE_LIMIT")
expect(ComposerCore.deliveryGraceMs, fixture.deliveryGraceMs, "DELIVERY_GRACE_MS")
expect(ComposerCore.clientIdPattern, fixture.clientIdPattern, "CLIENT_ID_RE.source")

// ── dropLanded ──────────────────────────────────────────────────────────────

for c in fixture.landed {
    let optimistic = c.optimistic.map {
        ComposerCore.Optimistic(id: $0.id, realId: $0.realId, content: $0.content)
    }
    let real = c.real.map { (id: $0.id, content: $0.content) }
    let kept = ComposerCore.dropLanded(optimistic, landed: real).map(\.id)
    expect(kept, c.kept, "dropLanded — \(c.why)")
}

// ── placeholder ─────────────────────────────────────────────────────────────

for c in fixture.placeholders {
    let face = ComposerCore.Face(
        disabled: c.face.disabled, awaitingInput: c.face.awaitingInput,
        queueFull: c.face.queueFull, working: c.face.working,
        uploadingCount: c.face.uploadingCount, dictating: c.face.dictating,
        touch: c.face.touch, brainGhost: c.face.brainGhost
    )
    expect(ComposerCore.placeholder(face), c.expected, "placeholder — \(c.why)")
}

// ── canSend ─────────────────────────────────────────────────────────────────

for c in fixture.canSend {
    let got = ComposerCore.canSend(
        disabled: c.input.disabled, awaitingInput: c.input.awaitingInput,
        queueFull: c.input.queueFull, uploadingCount: c.input.uploadingCount,
        draft: c.input.draft, readyAttachments: c.input.readyAttachments
    )
    expect(got, c.expected, "canSend — \(c.why)")
}

// ── turnInFlight ────────────────────────────────────────────────────────────

for c in fixture.flight {
    let got = ComposerCore.turnInFlight(ComposerCore.TurnSignals(
        statusState: c.input.statusState, snapshotAt: c.input.snapshotAt,
        lastRole: c.input.lastRole, lastAt: c.input.lastAt,
        optimisticAt: c.input.optimisticAt, streamingTail: c.input.streamingTail,
        now: c.input.now
    ))
    expect(got.waitingAssistant, c.expected.waitingAssistant, "turnInFlight.waitingAssistant — \(c.why)")
    expect(got.inFlight, c.expected.inFlight, "turnInFlight.inFlight — \(c.why)")
}

// ── stopPill ────────────────────────────────────────────────────────────────

for c in fixture.stop {
    let got = ComposerCore.stopPill(inFlight: c.inFlight, statusKey: c.statusKey, closed: c.closed)
    expect(got.turnRunning, c.expected.turnRunning, "stopPill.turnRunning — \(c.why)")
    expect(got.show, c.expected.show, "stopPill.show — \(c.why)")
}

// ── the idempotency key ─────────────────────────────────────────────────────

for c in fixture.clientIds {
    expect(ComposerCore.isValidClientId(c.id), c.ok, "clientId — \(c.why)")
}

// The keys this app actually mints have to survive the check above. A thousand
// of them, from two different install ids and a clock that moves, because the
// shape is `<install>:<millis>-<salt>` and only the salt varies inside a
// millisecond.
//
// Uniqueness is checked as well, and it is the weaker of the two: a collision
// here means a message the server would silently swallow as a retry.
var minted = Set<String>()
for i in 0..<1000 {
    let install = i % 2 == 0
        ? "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
        : "A1B2C3D4"
    let id = ComposerCore.newClientId(install: install,
                                      now: Date(timeIntervalSince1970: 1_757_000_000 + Double(i) / 1000))
    checks += 1
    if !ComposerCore.isValidClientId(id) { failures.append("newClientId produced an id the server refuses: \(id)") }
    minted.insert(id)
}
expect(minted.count, 1000, "newClientId is unique across 1000 mints")

// An install id long enough to overflow the cap must still produce a legal key.
checks += 1
let longId = ComposerCore.newClientId(install: String(repeating: "z", count: 400))
if !ComposerCore.isValidClientId(longId) {
    failures.append("newClientId with an over-long install id is not legal: \(longId.prefix(40))…")
}

// MARK: - Report

if failures.isEmpty {
    print("composer fixture: \(checks) checks, all agree with the web")
    exit(0)
}
print("composer fixture: \(checks) checks, \(failures.count) DISAGREE\n")
for f in failures { print("  ✗ \(f)") }
exit(1)
