// Drives the Swift port of `sessionStatusView` over the table the WEB produced.
//
//     apps/ios/tools/status-fixture.sh
//
// Every expectation in `tools/fixtures/status-cases.json` came out of running
// `apps/dashboard/src/lib/session-status.ts` (scripts/gen-status-fixture.ts), so
// nothing here encodes a belief about what the answer should be — a red line is
// always "the two implementations disagree", never "the test author disagrees".
import Foundation

// MARK: - The table

/// The activity column is opaque JSON: an object, a string, an array, or null.
/// Anything `SessionActivity` cannot describe decodes to nil, which is the same
/// "cannot say" the web reaches by shape-checking.
struct MaybeActivity: Decodable {
    let value: SessionActivity?
    init(from decoder: Decoder) throws { value = try? SessionActivity(from: decoder) }
    init(_ v: SessionActivity?) { value = v }
}

struct SessionJSON: Decodable {
    var alive: Bool?
    var state: String?
    var snapshotAt: Date?
    var activity: MaybeActivity?
    var backgroundBusy: Bool?
    var backgroundNote: String?
    var lastMessageAt: Date?
    var closedAt: Date?
    var restartRequestedAt: Date?

    var runtime: SessionRuntime {
        SessionRuntime(
            alive: alive, state: state, snapshotAt: snapshotAt, activity: activity?.value,
            backgroundBusy: backgroundBusy, backgroundNote: backgroundNote,
            lastMessageAt: lastMessageAt, closedAt: closedAt, restartRequestedAt: restartRequestedAt
        )
    }
}

struct OptsJSON: Decodable {
    var liveWorking: Bool?
    var unread: Bool?
    var needsYou: Bool?
    var now: Double?
    var observedAt: Double?
    var reachableSince: Double?

    var options: StatusOptions {
        StatusOptions(
            liveWorking: liveWorking ?? false, unread: unread ?? false, needsYou: needsYou ?? false,
            now: now, observedAt: observedAt, reachableSince: reachableSince
        )
    }
}

struct ExpectedView: Decodable, Equatable {
    var key: String
    var label: String
    var dot: String
    var pulse: Bool
    var detail: String?
}

struct ExpectedLabel: Decodable, Equatable {
    var label: String
    var detail: String?
}

struct ExpectedTask: Decodable, Equatable {
    var id: String
    var description: String
    var elapsedSec: Double
    var kind: String?
    var command: String?
    var outputTail: String?
}

struct MergedJSON: Decodable, Equatable {
    var alive: Bool?
    var state: String?
    var snapshotAt: Date?
    var activity: MaybeActivity?
    var closedAt: Date?
    var restartRequestedAt: Date?

    static func of(_ r: SessionRuntime?) -> MergedJSON? {
        guard let r else { return nil }
        return MergedJSON(alive: r.alive, state: r.state, snapshotAt: r.snapshotAt,
                          activity: r.activity.map { MaybeActivity($0) }, closedAt: r.closedAt,
                          restartRequestedAt: r.restartRequestedAt)
    }

    static func == (a: MergedJSON, b: MergedJSON) -> Bool {
        a.alive == b.alive && a.state == b.state && a.snapshotAt == b.snapshotAt
            && a.activity?.value == b.activity?.value
            && a.closedAt == b.closedAt && a.restartRequestedAt == b.restartRequestedAt
    }
}

struct Fixture: Decodable {
    struct Duration: Decodable { var sec: Double; var expected: String }
    struct Activity: Decodable {
        var name: String
        var activity: MaybeActivity?
        var label: ExpectedLabel?
        var summary: String?
        var tasks: [ExpectedTask]
    }
    struct Merge: Decodable {
        struct Live: Decodable {
            var state: String?
            var alive: Bool
            var activity: MaybeActivity?
            var snapshotAt: Date?
            var frame: LiveStatusFrame {
                LiveStatusFrame(state: state, alive: alive, activity: activity?.value, snapshotAt: snapshotAt)
            }
        }
        var name: String
        var session: SessionJSON?
        var live: Live?
        var merged: MergedJSON?
        var view: ExpectedView
    }
    struct Status: Decodable {
        var name: String
        var session: SessionJSON?
        var opts: OptsJSON
        var expected: ExpectedView
        var resting: Bool
        var silenceMs: Double?
    }
    var now: Double
    var snapshotStaleMs: Double
    var backgroundResidentMs: Double
    var durations: [Duration]
    var activities: [Activity]
    var statuses: [Status]
    var merges: [Merge]
}

// MARK: - Running it

var checks = 0
var failures: [String] = []

func expect<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    checks += 1
    if got != want { failures.append("\(what)\n      got  \(got)\n      want \(want)") }
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: "\(root)/tools/fixtures/status-cases.json")
guard let data = try? Data(contentsOf: path) else {
    FileHandle.standardError.write("cannot read \(path.path)\n".data(using: .utf8)!)
    exit(2)
}

let decoder = JSONDecoder()
// The table's timestamps carry milliseconds; ISO8601DateFormatter needs telling.
let withMs = ISO8601DateFormatter()
withMs.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let plain = ISO8601DateFormatter()
decoder.dateDecodingStrategy = .custom { d in
    let s = try d.singleValueContainer().decode(String.self)
    if let t = withMs.date(from: s) ?? plain.date(from: s) { return t }
    throw DecodingError.dataCorrupted(.init(codingPath: d.codingPath, debugDescription: "not ISO-8601: \(s)"))
}

let fixture: Fixture
do { fixture = try decoder.decode(Fixture.self, from: data) }
catch { FileHandle.standardError.write("fixture will not decode: \(error)\n".data(using: .utf8)!); exit(2) }

// The thresholds the table was BUILT with have to be the ones the port reads.
// Without this the two could drift together — a regenerated table and a
// regenerated contract would agree with each other and with nothing else.
expect(SessionStatus.snapshotStaleMs, fixture.snapshotStaleMs, "WebContract.snapshotStaleMs")
expect(SessionStatus.backgroundResidentMs, fixture.backgroundResidentMs, "WebContract.backgroundResidentMs")

for c in fixture.durations {
    expect(SessionStatus.shortDuration(c.sec), c.expected, "shortDuration(\(c.sec))")
}

for c in fixture.activities {
    let a = c.activity?.value
    let got = SessionStatus.activityLabel(a)
    expect(got.map { ExpectedLabel(label: $0.label, detail: $0.detail) }, c.label, "activityLabel[\(c.name)]")
    expect(SessionStatus.backgroundSummary(a), c.summary, "backgroundSummary[\(c.name)]")
    let tasks = SessionStatus.backgroundTaskList(a).map {
        ExpectedTask(id: $0.id, description: $0.description, elapsedSec: $0.elapsedSec,
                     kind: $0.kind, command: $0.command, outputTail: $0.outputTail)
    }
    expect(tasks, c.tasks, "backgroundTaskList[\(c.name)]")
}

for c in fixture.statuses {
    let v = SessionStatus.view(c.session?.runtime, c.opts.options)
    let got = ExpectedView(key: v.key.rawValue, label: v.label, dot: v.dot, pulse: v.pulse, detail: v.detail)
    expect(got, c.expected, "sessionStatusView[\(c.name)]")
    expect(SessionStatus.isRestingState(v.key), c.resting, "isRestingState[\(c.name)]")
    expect(SessionStatus.snapshotSilenceMs(c.session?.snapshotAt, c.opts.options), c.silenceMs,
           "snapshotSilenceMs[\(c.name)]")
    // Every dot the web can emit has to resolve to a colour on this side. A
    // class this build has never seen would otherwise be an invisible dot, and
    // nothing else in the pipeline would notice.
    checks += 1
    if StatusPalette.dot(v.dot) == nil {
        failures.append("StatusPalette.dot[\(c.name)]: no colour for \(v.dot)")
    }
}

// The opacity suffix is the difference between three pairs of states, so it is
// worth one direct look rather than only being exercised through the ladder.
expect(StatusPalette.dot("bg-amber-400")?.opacity, 1.0, "dot opacity, no suffix")
expect(StatusPalette.dot("bg-amber-400/50")?.opacity, 0.5, "dot opacity, /50")
expect(StatusPalette.dot("bg-emerald-500/30")?.opacity, 0.3, "dot opacity, /30")
checks += 1
if StatusPalette.dot("bg-fuchsia-600") != nil { failures.append("dot(): invented a colour for an unknown class") }
checks += 1
if StatusPalette.dot("bg-amber-400/x") != nil { failures.append("dot(): accepted a non-numeric opacity") }

// The pushed status frame folded into the polled row. Only the header consumes
// this today, and it is the reason `event: status` finally drives something.
for c in fixture.merges {
    let merged = SessionStatus.merge(c.session?.runtime, c.live?.frame)
    expect(MergedJSON.of(merged), c.merged, "mergeLiveStatus[\(c.name)]")
    let v = SessionStatus.view(merged, StatusOptions(unread: false, now: fixture.now))
    expect(ExpectedView(key: v.key.rawValue, label: v.label, dot: v.dot, pulse: v.pulse, detail: v.detail),
           c.view, "sessionStatusView after the merge[\(c.name)]")
}

// MARK: - Report

print("\(fixture.durations.count) durations · \(fixture.activities.count) activities · "
      + "\(fixture.statuses.count) statuses · \(fixture.merges.count) merges")
if failures.isEmpty {
    print("\u{2713} \(checks)/\(checks) checks")
    exit(0)
}
for f in failures { print("  \u{2717} \(f)") }
print("\u{2717} \(checks - failures.count)/\(checks) checks — \(failures.count) failed")
exit(1)
