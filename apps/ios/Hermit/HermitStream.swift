import Foundation

/// The live window's identity, in one place — the same reason
/// `apps/dashboard/src/lib/chat-window.ts` has it in one place on the web: the
/// tRPC query that LOADS the window and the SSE stream that PATCHES it have to
/// be describing the same window, or the stream merges rows into a list that
/// does not contain them.
///
/// Both values come from `WebContract`, which is generated from that very
/// file — they are the same number, not a copy of it.
enum TimelineWindow {
    /// `INITIAL_WINDOW`: the newest N messages. Fixed — "load earlier" pages
    /// older history separately rather than growing this.
    static let limit = WebContract.timelineLimit

    /// `TIMELINE_DIGEST`: ask for the collapsed projection (tool arguments
    /// trimmed to the chip's preview, results to their first line, thinking to
    /// its length). This MUST agree with what the window was fetched with: the
    /// two transports merge by id into one list, and a full-fidelity row landing
    /// in a digested window would re-expand a capsule the reader had collapsed —
    /// and change its height under them.
    static let digest = WebContract.timelineDigest
}

/// What a session is doing right now, as the gateway's runtime reports it.
///
/// Mirrors `SessionActivity` in `apps/dashboard/src/lib/session-status.ts`
/// field for field. It arrives through an opaque JSON column, so every field is
/// optional there and every field is optional here — a gateway older or newer
/// than this app must not make the frame undecodable.
struct SessionActivity: Decodable, Equatable {
    var kind: String?
    var label: String?
    var detail: String?
    var elapsedSec: Double?
    var attempt: Int?
    var maxRetries: Int?
    var retryInSec: Double?
    var backgroundCount: Int?
    /// What each background task IS, oldest first. A gateway older than
    /// 2026-09-02 sends only the count, which is why an absent list means
    /// "cannot say" and not "none".
    var backgroundTasks: [BackgroundTask]?

    struct BackgroundTask: Decodable, Equatable {
        var id: String?
        var description: String?
        var elapsedSec: Double?
        var kind: String?
        var command: String?
        var outputTail: String?
    }
}

/// The `event: status` frame — the session's runtime state, pushed the moment
/// the gateway writes it instead of waiting for the next 5s poll.
///
/// Mirrors `SessionStatusFrame` in `apps/dashboard/src/server/session-status-frame.ts`.
/// The field names are deliberately the ones the status view reads, so a
/// consumer merges the frame INTO its session row rather than keeping a second
/// opinion beside it.
struct SessionStatusFrame: Decodable, Equatable {
    var state: String?
    var alive: Bool
    var activity: SessionActivity?
    /// When the gateway last reported on this session. Rides along because it is
    /// what the staleness rule measures — a frame without it would be a status
    /// nothing could ever expire.
    var snapshotAt: Date?
    var closedAt: Date?
    var restartRequestedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case state, alive, activity, snapshotAt, closedAt, restartRequestedAt
    }

    /// Written out rather than synthesised so `activity` can fail on its own.
    /// It is an opaque JSON column: a row holding something this struct does not
    /// describe must cost us the activity line, not the whole frame — and with
    /// it the state, which is the part the header actually needs.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        alive = (try? c.decodeIfPresent(Bool.self, forKey: .alive)) ?? false
        activity = try? c.decodeIfPresent(SessionActivity.self, forKey: .activity)
        snapshotAt = try c.decodeIfPresent(Date.self, forKey: .snapshotAt)
        closedAt = try c.decodeIfPresent(Date.self, forKey: .closedAt)
        restartRequestedAt = try c.decodeIfPresent(Date.self, forKey: .restartRequestedAt)
    }
}

/// Failures that belong to the stream itself. An HTTP refusal is thrown as
/// `HermitAPIError.http` instead, so `isRetriable` / `isUnauthorized` mean the
/// same thing on both transports.
enum HermitStreamError: LocalizedError, Equatable {
    /// The origin plus the route did not make a URL. A programming error.
    case badURL(String)
    /// No byte — not even the server's 15s keep-alive ping — for this long.
    case stalled(after: TimeInterval)
    /// A 2xx that is not an event stream: a captive portal, or a proxy that
    /// answered on the server's behalf.
    case notAStream(contentType: String)

    var errorDescription: String? {
        switch self {
        case .badURL(let u): return "bad stream URL: \(u)"
        case .stalled(let s): return "no data for \(Int(s))s — the connection is a zombie"
        case .notAStream(let t): return "not an event stream (content-type: \(t))"
        }
    }

    var isRetriable: Bool {
        switch self {
        case .badURL: return false
        case .stalled, .notAStream: return true
        }
    }
}

/// The one `URLSession` every `HermitStream` runs on.
///
/// Outside the generic class because Swift does not allow a static stored
/// property there — and it wants to be shared anyway: every stream asks for
/// the identical configuration, and a session per stream is a lifetime
/// question (who invalidates it, and when) bought for nothing.
enum HermitStreamSession {
    /// **`HermitAPI`'s session is deliberately not reused.** It sets
    /// `timeoutIntervalForResource = 30`, which is a total-lifetime cap: a stream
    /// on that session would be killed thirty seconds in, every time, forever,
    /// and the symptom would be a timeline that updates for half a minute after
    /// each reconnect and then goes quiet. The per-request "no new data" timeout
    /// is set per request instead, from the stream's own `idleDeadline`.
    static let shared: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForResource = 60 * 60 * 24 * 7  // a stream may legitimately live for hours
        c.waitsForConnectivity = false                   // offline must fail now; the reconnect loop decides when to try again
        c.httpShouldSetCookies = false                   // auth is the x-asst-key header and nothing else
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        return URLSession(configuration: c)
    }()
}

/// `GET /api/chat/stream` — one chat session's timeline, pushed as
/// Server-Sent Events, decoded into typed frames.
///
/// **The credential red line is unchanged.** Like `HermitAPI`, this never reads
/// the Keychain and never chooses a key: it calls a closure the caller hands it,
/// and nothing in the shell constructs one today.
///
/// ## Why not `EventSource`, or any SSE library
///
/// Auth on this route is the `x-asst-key` header, and `EventSource` cannot set a
/// header — which is exactly why the web client uses `fetch()` plus a
/// `ReadableStream` reader instead (`app/chat/page.tsx`). Every SSE package for
/// Swift is either built on that same header-less shape or brings a whole HTTP
/// stack with it. `URLSession.bytes(for:)` is an ordinary request, with
/// ordinary headers, whose body arrives as it is written — the same shape the
/// web uses, one layer down.
///
/// ## The two frames
///
/// ```
/// event: messages   data: {"rows":[…],"gone":["id",…]}   // delta=1
/// event: messages   data: [ … ]                          // a server predating delta=1
/// event: status     data: {"state":…,"alive":…,"activity":…}
/// : ping                                                  // a comment, every 15s
/// ```
///
/// A frame with no `event:` line is a message push; that is what the server sent
/// before the status channel existed. Both payloads are plain JSON — superjson
/// is not involved on this route, so unlike the tRPC path there is no envelope
/// to strip.
///
/// ## Lifecycle
///
/// `start()` connects and keeps reconnecting; `stop()` (or dropping the object,
/// or breaking out of `for await`) tears it down for good. It does not restart:
/// `events` is finished once, and a caller that wants another connection makes
/// another `HermitStream`. The owner is expected to `stop()` when the app leaves
/// the foreground and make a new one on return — the same pause the web does on
/// `visibilitychange`, and for the same reason: a backgrounded session
/// otherwise keeps the server querying Postgres on its 2s safety-net tick
/// forever.
///
/// Foundation only, no UIKit — so `tools/stream-fixture.sh` can compile and
/// drive it on the Mac without a simulator.
final class HermitStream<Row: Decodable> {

    // MARK: - What comes out

    enum Event {
        /// The handshake completed. Whatever fallback poll the caller runs while
        /// disconnected can go quiet now.
        case connected
        /// Rows to merge, plus the ids that have LEFT the window. `gone` is
        /// empty for the whole-window shape, which carries no such list.
        case messages(rows: [Row], gone: [String])
        /// The session's runtime state.
        case status(SessionStatusFrame)
        /// One frame could not be read. The connection is fine and the next
        /// frame will be delivered; this exists so a schema drift shows up as
        /// something rather than as a timeline that quietly stops moving.
        case frameDropped(Error)
        /// The connection ended — `nil` when the server closed it cleanly. A
        /// reconnect is already scheduled UNLESS `events` finishes right after
        /// this, which is how a permanent refusal (a bad key, a deleted session)
        /// is reported.
        case disconnected(Error?)
    }

    /// Every event, in order.
    ///
    /// Buffering is unbounded on purpose. `delta=1` frames are increments, not
    /// snapshots: dropping one under back-pressure leaves a hole in the timeline
    /// that nothing later refills, so `.bufferingNewest` would be silently
    /// lossy in exactly the case it looks prudent.
    let events: AsyncStream<Event>

    private let emit: AsyncStream<Event>.Continuation
    private let cfg: Config
    private var task: Task<Void, Never>?

    /// - Parameters:
    ///   - origin: the dashboard. Only scheme/host/port are used — a path or
    ///     query is dropped, because `-hermitOrigin` is allowed to carry a route.
    ///   - key: read fresh on every connect and never stored, the same contract
    ///     `authedFetch` has on the web.
    ///   - skipInitial: does the caller ALREADY hold this window (it just
    ///     fetched it through `chat.listMessages`)? Then the first connect asks
    ///     the server not to restate it — that is the open-time double-fetch the
    ///     flag exists to remove. Reconnects never skip: the emit after a gap is
    ///     how the client catches up on what it missed. Pass `false` when
    ///     starting with nothing cached.
    ///   - idleDeadline: the zombie watchdog. The server pings every 15s, so
    ///     silence past this means a half-open connection — after sleep, a
    ///     network switch, or a proxy's idle kill — and the read would otherwise
    ///     hang forever with the caller believing it is connected.
    init(origin: URL,
         sessionId: String,
         key: @escaping @Sendable () -> String,
         limit: Int = TimelineWindow.limit,
         digest: Bool = TimelineWindow.digest,
         skipInitial: Bool = true,
         backoffs: [TimeInterval] = WebContract.streamBackoffs,
         idleDeadline: TimeInterval = WebContract.streamIdleDeadline,
         session: URLSession? = nil) {
        self.cfg = Config(
            root: HermitAPI.rootOf(origin),
            sessionId: sessionId,
            limit: limit,
            digest: digest,
            skipInitialOnFirstConnect: skipInitial,
            // An empty schedule would make the reconnect index out of range on
            // the first drop — a crash, in the one code path that only runs when
            // something else already went wrong.
            backoffs: backoffs.isEmpty ? [1] : backoffs,
            idleDeadline: idleDeadline,
            key: key,
            session: session ?? HermitStreamSession.shared
        )
        var handle: AsyncStream<Event>.Continuation!
        self.events = AsyncStream(Event.self, bufferingPolicy: .unbounded) { handle = $0 }
        self.emit = handle
    }

    deinit { task?.cancel() }

    /// Connect, and keep reconnecting until `stop()`. Calling it twice is a
    /// no-op.
    func start() {
        guard task == nil else { return }
        let config = cfg
        let out = emit
        let t = Task { await HermitStream.run(config, out) }
        task = t
        // A consumer that walks away — breaks out of `for await`, or cancels the
        // task doing the iterating — should take the connection with it. Without
        // this, an abandoned stream keeps the socket open and keeps the server
        // polling Postgres for it.
        emit.onTermination = { _ in t.cancel() }
    }

    /// Tear down for good. `events` finishes; it does not reopen.
    func stop() {
        task?.cancel()
        task = nil
    }

    private struct Config: @unchecked Sendable {
        let root: String
        let sessionId: String
        let limit: Int
        let digest: Bool
        let skipInitialOnFirstConnect: Bool
        let backoffs: [TimeInterval]
        let idleDeadline: TimeInterval
        let key: @Sendable () -> String
        let session: URLSession
    }

    // MARK: - The reconnect loop
    //
    // Static, over a value, rather than methods on `self`. An instance method
    // running inside a `Task` keeps `self` alive for as long as the task runs,
    // so `deinit` could never fire and could never cancel it — the object would
    // outlive its owner and go on streaming.

    private static func run(_ cfg: Config, _ emit: AsyncStream<Event>.Continuation) async {
        var attempts = 0        // consecutive failed connects → index into the backoff schedule
        var isReconnect = false
        while !Task.isCancelled {
            do {
                let skip = !isReconnect && cfg.skipInitialOnFirstConnect
                let bytes = try await connect(cfg, skipInitial: skip)
                attempts = 0    // a good connect resets the backoff
                emit.yield(.connected)
                try await pump(cfg, bytes, emit)
                if Task.isCancelled { break }
                emit.yield(.disconnected(nil))   // clean end of body: the server closed
            } catch {
                if Task.isCancelled || error is CancellationError { break }
                emit.yield(.disconnected(error))
                // Where this parts company with the web client, which reconnects
                // after ANY failure forever. A 401 or a 404 is not a condition
                // that clears on its own: the key is wrong, or the session is
                // gone. Retrying every five seconds for the life of the process
                // costs a phone its battery to learn the same thing each time,
                // so the sequence ends and the caller decides what to do.
                guard retriable(error) else { break }
            }
            isReconnect = true
            let delay = cfg.backoffs[min(attempts, cfg.backoffs.count - 1)]
            attempts += 1
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { break }
        }
        emit.finish()
    }

    private static func retriable(_ error: Error) -> Bool {
        if let e = error as? HermitAPIError { return e.isRetriable }
        if let e = error as? HermitStreamError { return e.isRetriable }
        return true   // URLError and anything else: a condition, not a bad request
    }

    // MARK: - Connecting

    /// Mirrors `timelineStreamParams` in `lib/chat-window.ts`, parameter for
    /// parameter and in the same order, so a request line from the phone and one
    /// from a browser can be diffed by eye in a server log.
    static func urlString(root: String, sessionId: String, limit: Int, digest: Bool, skipInitial: Bool) -> String {
        var s = "\(root)/api/chat/stream"
            + "?sessionId=" + HermitAPI.percentEncoded(sessionId)
            + "&limit=\(limit)"
            + "&delta=1"    // send me only what changed, plus the ids that left
            + "&status=1"   // I understand `event: status` frames
        if digest { s += "&digest=1" }
        if skipInitial { s += "&skipInitial=1" }
        return s
    }

    private static func connect(_ cfg: Config, skipInitial: Bool) async throws -> URLSession.AsyncBytes {
        let s = urlString(root: cfg.root, sessionId: cfg.sessionId,
                          limit: cfg.limit, digest: cfg.digest, skipInitial: skipInitial)
        guard let target = URL(string: s) else { throw HermitStreamError.badURL(s) }

        var req = URLRequest(url: target)
        req.httpMethod = "GET"
        req.setValue(cfg.key(), forHTTPHeaderField: "x-asst-key")
        req.setValue("text/event-stream", forHTTPHeaderField: "accept")
        req.setValue("no-cache", forHTTPHeaderField: "cache-control")
        // URLSession's own "no new data for this long" timer, set to the same
        // deadline as the watchdog below. Belt and braces on purpose: the OS
        // timer is free, and the explicit watchdog is the one we can prove fires
        // (tools/stream-fixture.sh drives it).
        req.timeoutInterval = cfg.idleDeadline

        let (bytes, response) = try await cfg.session.bytes(for: req)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // Thrown as an API error, not a stream error, so `isUnauthorized`
            // and `isRetriable` answer the same way they do for a tRPC call.
            throw HermitAPIError.http(status: status, body: await preview(bytes))
        }
        // A 200 that is not an event stream is a captive portal or a proxy
        // answering for the server. It would degrade into a reconnect loop
        // either way — this only makes the reason readable instead of leaving
        // "the timeline stopped updating" as the only symptom.
        let ctype = (http?.value(forHTTPHeaderField: "content-type") ?? "").lowercased()
        guard ctype.hasPrefix("text/event-stream") else {
            throw HermitStreamError.notAStream(contentType: ctype.isEmpty ? "<none>" : ctype)
        }
        return bytes
    }

    /// Enough of a refusal's body to recognise it, and not so much that an HTML
    /// error page floods the log.
    private static func preview(_ bytes: URLSession.AsyncBytes) async -> String {
        var buf = Data()
        do {
            for try await b in bytes {
                buf.append(b)
                if buf.count >= 400 { break }
            }
        } catch { /* the body is a nicety; the status is the answer */ }
        let s = String(data: buf, encoding: .utf8) ?? "<\(buf.count) bytes>"
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Reading

    /// Reads until the body ends, the watchdog fires, or the task is cancelled.
    private static func pump(_ cfg: Config,
                             _ bytes: URLSession.AsyncBytes,
                             _ emit: AsyncStream<Event>.Continuation) async throws {
        let beat = Heartbeat()
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await read(bytes, beat, emit) }
            group.addTask { try await watch(beat, deadline: cfg.idleDeadline) }
            // Whichever finishes first decides: a clean end of body returns, a
            // stall or a transport error throws. Either way the other child is
            // cancelled on the way out — and because these are CHILD tasks, a
            // cancel of the enclosing run loop reaches them too, which is what
            // makes `stop()` close the socket rather than orphan it.
            try await group.next()
            group.cancelAll()
        }
    }

    private static func read(_ bytes: URLSession.AsyncBytes,
                             _ beat: Heartbeat,
                             _ emit: AsyncStream<Event>.Continuation) async throws {
        var name = "messages"      // no `event:` line means a message push
        var payload: [String] = []
        var line = [UInt8]()
        var swallowLF = false      // the LF half of a CRLF whose CR already ended a line

        // Splitting the raw bytes by hand, and NOT with Foundation's `.lines`.
        //
        // `AsyncLineSequence` drops every empty line — `"a\n\nb\n"` comes out as
        // ["a", "b"], with no way to ask it not to. In SSE the blank line IS the
        // frame terminator, so on `.lines` this client connects, reads a whole
        // conversation's worth of fields and delivers absolutely nothing, then
        // reports a clean end of stream. Nothing throws and nothing logs.
        // (tools/stream-fixture.sh caught it on its first run; `swiftc
        // -typecheck` cannot.)
        //
        // The cost is one `await` per byte, which is what `.lines` does
        // internally anyway — so there is nothing cheaper short of a
        // `URLSessionDataDelegate` handing over whole chunks. If a profile ever
        // says this matters, that is the escape hatch.
        func endOfLine() {
            let text = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            // Any line at all counts as life, including the server's 15s
            // `: ping`. Per LINE rather than per byte so the watchdog is not a
            // lock acquisition on every byte of the stream; a single line big
            // enough for that to matter arrives in one write, and the request's
            // own timeout is the backstop if it somehow does not.
            beat.felt()
            if text.isEmpty {      // blank line: the frame is complete
                deliver(name: name, payload: payload.joined(separator: "\n"), emit)
                name = "messages"
                payload.removeAll(keepingCapacity: true)
                return
            }
            if text.hasPrefix(":") { return }   // a comment — `: open`, `: ping`
            guard let colon = text.firstIndex(of: ":") else { return }
            let field = text[text.startIndex..<colon]
            var value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
            switch field {
            case "event": name = String(value)
            case "data": payload.append(String(value))
            default: break        // `id:` and `retry:`; this route sends neither
            }
        }

        for try await b in bytes {
            switch b {
            case 0x0A:                                   // LF
                if swallowLF { swallowLF = false; continue }
                endOfLine()
            case 0x0D:                                   // CR, possibly of a CRLF
                swallowLF = true
                endOfLine()
            default:
                swallowLF = false
                line.append(b)
            }
        }
        // A body that ends without a trailing newline leaves a partial frame.
        // It is deliberately NOT delivered: a truncated `data:` line is a
        // half-received JSON document, and merging one would put a row into the
        // timeline with fields the server never finished sending.
    }

    /// Joining multiple `data:` lines with a newline is what the SSE grammar
    /// says, and it cannot diverge from the web client (which reads only the
    /// first): both sides of this stream serialise with a JSON encoder, and
    /// neither emits a raw newline inside one.
    private static func deliver(name: String, payload: String, _ emit: AsyncStream<Event>.Continuation) {
        guard !payload.isEmpty, let raw = payload.data(using: .utf8) else { return }
        do {
            switch name {
            case "status":
                emit.yield(.status(try HermitAPI.decoder.decode(SessionStatusFrame.self, from: raw)))
            case "messages":
                let push = try decodePush(raw)
                emit.yield(.messages(rows: push.rows, gone: push.gone))
            default:
                // A frame type this build does not know. A newer server may add
                // one at any time — including while this app sits on a phone
                // that will not be updated for weeks — so it is skipped in
                // silence rather than reported as a broken frame.
                break
            }
        } catch {
            emit.yield(.frameDropped(error))
        }
    }

    private struct Delta: Decodable {
        let rows: [Row]
        let gone: [String]?
    }

    /// `delta=1` gets `{rows, gone}`; a server predating the flag sends a bare
    /// array, and one may be on the wire during a deploy.
    ///
    /// The shape is SNIFFED rather than tried-and-caught, so that a failure
    /// reports the real problem. Decoding `{rows:[…]}` as an array first fails
    /// with "expected an array, found a dictionary" — which is what you would
    /// then go and investigate, instead of the row that actually did not fit.
    private static func decodePush(_ raw: Data) throws -> (rows: [Row], gone: [String]) {
        let first = raw.first(where: { $0 != 0x20 && $0 != 0x09 && $0 != 0x0a && $0 != 0x0d })
        if first == UInt8(ascii: "[") {
            return (try HermitAPI.decoder.decode([Row].self, from: raw), [])
        }
        let d = try HermitAPI.decoder.decode(Delta.self, from: raw)
        return (d.rows, d.gone ?? [])
    }

    // MARK: - The zombie watchdog

    private static func watch(_ beat: Heartbeat, deadline: TimeInterval) async throws {
        // Five checks per deadline: fine enough that the fixture's sub-second
        // deadline is still measured properly, coarse enough that production's
        // 35s costs one timestamp comparison every seven seconds.
        let tick = max(0.2, deadline / 5)
        while true {
            try await Task.sleep(nanoseconds: UInt64(tick * 1_000_000_000))
            if beat.silence() > deadline { throw HermitStreamError.stalled(after: deadline) }
        }
    }

    /// When the last byte arrived. Touched by the read loop and by the watchdog,
    /// on different threads, hence the lock.
    ///
    /// Wall clock (`Date`), not a monotonic one, and that is the right choice
    /// here rather than an oversight: a suspended app runs no code, so the whole
    /// sleep is invisible to a monotonic clock — and "the phone was asleep for
    /// an hour" is precisely the case where the connection underneath is most
    /// likely already dead. The wall clock shows the gap and forces a reconnect.
    private final class Heartbeat {
        private let lock = NSLock()
        private var last = Date()
        func felt() { lock.lock(); last = Date(); lock.unlock() }
        func silence() -> TimeInterval {
            lock.lock(); defer { lock.unlock() }
            return Date().timeIntervalSince(last)
        }
    }
}
