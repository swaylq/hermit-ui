// Drives HermitStream against tools/stream-fixture/server.py and prints every
// event it produced, in order. Not a test target — `swiftc -typecheck
// Hermit/*.swift` cannot see this file, so it is run, not compiled by accident.
// There are no assertions on purpose: the point is to LOOK at the sequence.
//
//     apps/ios/tools/stream-fixture.sh
import Foundation

/// The row shape `/api/chat/stream` sends, which is the same narrow select
/// `chat.listMessages` returns (id, role, content, createdAt, authoredBy) — the
/// two transports merge into one list, so they have to be the same rows.
/// Declared here rather than in the app: the timeline has no Swift model yet
/// (docs/ios-native-progress.md, M4「消息块的真 schema」), and inventing one
/// early would prejudge it.
struct Row: Decodable {
    let id: String
    let role: String
    let content: String
    let createdAt: Date
    let authoredBy: String?
}

let port = CommandLine.arguments[1]
// The origin carries a path, a query and a fragment on purpose: `-hermitOrigin`
// is allowed to (AppConfig.launchArgumentOrigin), and none of it may end up in
// front of /api/chat/stream.
let origin = URL(string: "http://127.0.0.1:\(port)/push?x=1#frag")!

func say(_ s: String) { print(s); fflush(stdout) }

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func short(_ e: Error) -> String {
    let s = (e as? LocalizedError)?.errorDescription ?? "\(e)"
    return String(s.replacingOccurrences(of: "\n", with: " ").prefix(96))
}

func describe(_ e: HermitStream<Row>.Event) -> String {
    switch e {
    case .connected:
        return "connected"
    case .messages(let rows, let gone):
        let ids = rows.map { "\($0.id)/\($0.role)/\($0.content)@\(iso.string(from: $0.createdAt))/\($0.authoredBy ?? "nil")" }
        return "messages   rows=[\(ids.joined(separator: "  "))] gone=\(gone)"
    case .status(let f):
        let act = f.activity.map { "\($0.kind ?? "nil")/\($0.label ?? "nil") bg=\($0.backgroundCount.map(String.init) ?? "nil")"
            + " tasks=\(($0.backgroundTasks ?? []).map { $0.id ?? "nil" })" } ?? "nil"
        let snap = f.snapshotAt.map { iso.string(from: $0) } ?? "nil"
        return "status     state=\(f.state ?? "nil") alive=\(f.alive) snapshotAt=\(snap) activity=\(act)"
    case .frameDropped(let err):
        return "dropped    \(short(err))"
    case .disconnected(let err):
        return "disconnect \(err.map(short) ?? "clean EOF — the server closed it")"
    }
}

/// Runs one scene until it has seen `want` events, the stream finishes on its
/// own, or `seconds` elapse — whichever comes first — and says which of the
/// three it was. "The sequence ended by itself" is the whole point of the
/// unauthorized scene, so it has to be visible in the output.
func drive(_ title: String,
           _ sessionId: String,
           want: Int,
           seconds: Double,
           skipInitial: Bool = true,
           idle: TimeInterval = 1.0,
           backoffs: [TimeInterval] = [0.2]) async {
    say("")
    say("── \(title) ".padding(toLength: 62, withPad: "─", startingAt: 0))
    let stream = HermitStream<Row>(origin: origin,
                                   sessionId: sessionId,
                                   key: { "K-FIXTURE" },
                                   skipInitial: skipInitial,
                                   backoffs: backoffs,
                                   idleDeadline: idle)
    stream.start()
    let deadline = Task {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        stream.stop()
    }
    var seen = 0
    var hitWant = false
    for await event in stream.events {
        seen += 1
        say("  \(describe(event))")
        if seen >= want { hitWant = true; break }
    }
    deadline.cancel()
    stream.stop()
    if !hitWant {
        say("  → the sequence FINISHED after \(seen) event(s) — no further reconnect")
    }
}

let done = DispatchSemaphore(value: 0)
Task<Void, Never> {
    say("root  \(HermitAPI.rootOf(origin))")
    say("url   \(HermitStream<Row>.urlString(root: HermitAPI.rootOf(origin), sessionId: "s_frames", limit: 60, digest: true, skipInitial: true))")

    // Every frame shape, then a clean close, then a reconnect that must NOT ask
    // for skipInitial (that emit is how the client catches up on the gap).
    await drive("every frame shape, then reconnect", "s_frames", want: 12, seconds: 6)

    // Opens and then says nothing. Nothing else in the app would ever notice:
    // the read just never returns.
    await drive("the zombie watchdog (1s deadline)", "s_silent", want: 4, seconds: 6)

    // A 401 is not a condition that clears on its own. One attempt, then the
    // sequence ends — the server log below should show exactly one request.
    await drive("401: give up, do not hammer", "s_unauth", want: 6, seconds: 3)

    // A captive portal. Retriable, because it does clear on its own.
    await drive("a 200 that is not an event stream", "s_notstream", want: 2, seconds: 3)

    done.signal()
}
done.wait()
