import Foundation

/// The socket to `/api/asr/<sessionId>`, and nothing else.
///
/// The native half of `apps/dashboard/src/lib/asr-socket.ts` — minus everything
/// that decides what the words ARE, which is `DictationCore.swift` and is run
/// against the web's own answers by `tools/hold-fixture.sh`. What is left here
/// is the transport: the handshake, the pre-open buffer, and the two timeouts.
///
/// ## Auth is a SUBPROTOCOL, not a header
///
/// The shell could set `x-asst-key` on this request — it is not a browser and
/// nothing stops it. The server does not read it: `/api/asr` authenticates the
/// `hermit-key.<token>` entry in `Sec-WebSocket-Protocol`, because the browser
/// half cannot set a header on a WebSocket and that is the only channel it has.
/// Sending the header instead would 401 with a message about a missing key while
/// the key sat in the request.
///
/// ## Every callback lands on the main queue
///
/// `URLSessionWebSocketTask` delivers on its own queue, and everything upstream
/// of this writes into a draft the keyboard is typing into. Hopping here means
/// no caller has to remember to.
final class AsrSocket {
    struct Events {
        /// The ASR task is live; audio is being transcribed.
        var onReady: () -> Void = {}
        /// Any of the three layers changed.
        var onState: (DictationState) -> Void = { _ in }
        /// A sentence closed — the capture layer's fallback buffer can go.
        var onSentence: () -> Void = {}
        /// `stop()` finished and everything landed. The tail is final.
        var onDone: (String) -> Void = { _ in }
        /// The socket is unusable. The caller falls back, or gives up.
        var onFailure: (String) -> Void = { _ in }
    }

    /// Audio held while the socket is still opening — ~4 s, well past a normal
    /// connect. The mic is already live during the handshake; holding the first
    /// syllables beats clipping them.
    private static let preopenMaxBytes = 4 * 16_000 * 2
    /// `stop()` waits this long for the tail and its corrections.
    private static let doneTimeout: TimeInterval = 12

    private let task: URLSessionWebSocketTask
    private let session: URLSession
    private let events: Events

    private var model = AsrModel()
    private var dead = false
    private var stopping = false
    private var open = false
    private var preopen: [Data] = []
    private var preopenBytes = 0
    private var doneTimer: Timer?

    /// - Parameters:
    ///   - root: scheme + host + port, as `HermitAPI.rootOf` produces.
    ///   - key: the machine key, read once — a socket cannot re-authenticate
    ///     mid-stream, so unlike `HermitAPI` there is nothing to re-read.
    init?(root: String, sessionId: String, key: String, events: Events,
          session: URLSession = .shared) {
        guard var c = URLComponents(string: root) else { return nil }
        c.scheme = c.scheme == "http" ? "ws" : "wss"
        c.path = "/api/asr/" + sessionId
        guard let url = c.url else { return nil }

        self.session = session
        self.events = events
        self.task = session.webSocketTask(with: url, protocols: ["hermit-key.\(key)"])
        task.resume()
        receive()
    }

    // MARK: - Sending

    /// Queue 16 kHz mono PCM16. Buffered until the socket opens.
    func send(_ pcm: Data) {
        guard !dead, !stopping else { return }
        guard open else {
            preopen.append(pcm)
            preopenBytes += pcm.count
            while preopenBytes > Self.preopenMaxBytes && preopen.count > 1 {
                preopenBytes -= preopen.removeFirst().count
            }
            return
        }
        task.send(.data(pcm)) { _ in /* a write that fails is a close, and the read sees it */ }
    }

    /// Ask the server to close the ASR task and flush. Resolves via `onDone`.
    func stop() {
        guard !dead, !stopping else { return }
        stopping = true
        let frame = #"{"type":"stop"}"#
        task.send(.string(frame)) { [weak self] error in
            guard let self else { return }
            DispatchQueue.main.async {
                if error != nil { self.settleDone(); return }
                self.doneTimer = Timer.scheduledTimer(withTimeInterval: Self.doneTimeout,
                                                      repeats: false) { [weak self] _ in
                    self?.settleDone()
                }
            }
        }
    }

    /// Drop it now: no flush, no events.
    func close() {
        dead = true
        doneTimer?.invalidate()
        doneTimer = nil
        task.cancel(with: .goingAway, reason: nil)
    }

    // MARK: - Receiving

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            DispatchQueue.main.async {
                switch result {
                case let .success(message):
                    // The first message is proof the handshake finished, which is
                    // the only "open" signal `URLSessionWebSocketTask` offers
                    // without a delegate. The server sends `ready` unprompted, so
                    // this is never a long wait.
                    self.flushPreopen()
                    if case let .string(text) = message { self.apply(text) }
                    if case let .data(bytes) = message,
                       let text = String(data: bytes, encoding: .utf8) { self.apply(text) }
                    if !self.dead { self.receive() }
                case .failure:
                    // A close we did not ask for is a failure; one during stop()
                    // means the server hung up before `done` — the sentences
                    // already closed are still good, so that is a clean finish.
                    if self.dead { return }
                    if self.stopping { self.settleDone() } else { self.fail("connection closed") }
                }
            }
        }
    }

    private func flushPreopen() {
        guard !open else { return }
        open = true
        for chunk in preopen { task.send(.data(chunk)) { _ in } }
        preopen = []
        preopenBytes = 0
    }

    private func apply(_ raw: String) {
        guard !dead else { return }
        let step = AsrReduce.step(model, raw)
        // A frame the reducer ignored hands the same value back, and redrawing on
        // it would write the identical tail into the draft again. Same test the
        // web makes, for the same reason — see `lib/asr-reduce.ts`.
        let changed = step.model != model
        model = step.model
        switch step.effect {
        case .ready:
            events.onReady()
        case .sentence:
            emit()
            events.onSentence()
        case .done:
            emit()
            settleDone()
        case let .fail(message):
            fail(message)
        case .none:
            if changed { emit() }
        }
    }

    private func emit() {
        guard !dead else { return }
        events.onState(AsrReduce.state(model))
    }

    private func settleDone() {
        guard !dead else { return }
        dead = true
        doneTimer?.invalidate()
        doneTimer = nil
        events.onDone(AsrReduce.state(model).tail)
        task.cancel(with: .normalClosure, reason: nil)
    }

    private func fail(_ message: String) {
        guard !dead else { return }
        dead = true
        doneTimer?.invalidate()
        doneTimer = nil
        events.onFailure(message)
        task.cancel(with: .goingAway, reason: nil)
    }
}
