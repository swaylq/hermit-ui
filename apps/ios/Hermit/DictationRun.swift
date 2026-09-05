import Foundation

/// One dictation run, orchestrated: the microphone, the socket, and the words
/// going into the draft.
///
/// The native half of `components/chat/dictation-dock.tsx`, which renders
/// nothing either — a held run has the full-screen overlay, and a hands-free one
/// is watched IN THE BOX, where the words are landing.
///
/// ## Two ways in, because the way OUT differs
///
///   `.hold` — the composer's box is still held down. Releasing finishes it, and
///             where the finger is at that moment decides send / cancel / edit
///             (`ChatTimelineViewController` owns that gesture, `HoldToTalkView`
///             draws it).
///   `.tap`  — hands-free, from the mic button beside the box. The same button,
///             pressed again, finishes it.
///
/// ## What this round does NOT do, and says so
///
/// The web degrades rather than fails: when the socket cannot be had (no key for
/// it, no model configured, a connection dropped mid-sentence) the run keeps
/// going as a plain recording and the whole utterance goes to `/api/transcribe`
/// on release. It also runs a whole-passage correction pass at the end
/// (`worthRefining`, which is ported and tested here but not yet called). Both
/// are separate lines in `docs/ios-native-progress.md`. Until they land, a
/// socket that will not open ends the run and SAYS so — it never pretends to be
/// listening, which is the one failure this feature cannot survive quietly.
@MainActor
final class DictationRun {
    enum Source { case hold, tap }

    /// A run this long stops on its own — a mic nobody closed is a bug.
    private static let runMax: TimeInterval = 20 * 60
    /// Continuous silence that ends a run. Long enough to think, short enough
    /// not to eavesdrop.
    private static let silenceStop: TimeInterval = 30

    struct Callbacks {
        /// The run started or ended. `source` is nil once it has ended.
        var onActive: (Bool, Source?) -> Void = { _, _ in }
        /// Everything this run has dictated so far, to be folded into the draft.
        var onTail: (String) -> Void = { _ in }
        /// Loudness, 0…1.
        var onLevel: (Double) -> Void = { _ in }
        /// Something to say out loud — the composer's amber notice line.
        var onNotice: (String) -> Void = { _ in }
        /// The run tore itself down. The composer un-arms the mic on this.
        var onFinished: () -> Void = {}
    }

    private(set) var active = false
    private(set) var source: Source?
    /// When the run started, for the overlay's clock.
    private(set) var startedAt = Date()

    private let root: String
    private let sessionId: String
    private let key: String
    private let callbacks: Callbacks

    private var capture: VoiceCapture?
    private var socket: AsrSocket?
    private var silenceAt = Date()
    private var timer: Timer?
    /// The last tail this run wrote. Kept so `cancel()` can take back exactly
    /// what it put in and nothing else.
    private var tail = ""

    init(root: String, sessionId: String, key: String, callbacks: Callbacks) {
        self.root = root
        self.sessionId = sessionId
        self.key = key
        self.callbacks = callbacks
    }

    // MARK: - Starting

    /// Start a run of this kind.
    ///
    /// If one is already live this RE-LABELS it rather than restarting anything:
    /// the press-and-hold opens every run as `.hold` so the mic is live from
    /// touch-down and no syllable is lost, and a quick release becomes
    /// hands-free. Restarting would throw away the audio that made it worth
    /// keeping the mic open early.
    func start(_ source: Source) {
        if active { self.source = source; callbacks.onActive(true, source); return }
        guard VoiceCapture.authorized else {
            callbacks.onNotice(VoiceCapture.denied ? "麦克风被拒绝，去系统设置开启" : "需要麦克风权限才能说话")
            callbacks.onFinished()
            return
        }

        self.source = source
        active = true
        startedAt = Date()
        silenceAt = Date()
        tail = ""
        callbacks.onActive(true, source)

        var events = AsrSocket.Events()
        events.onState = { [weak self] state in self?.wrote(state.tail) }
        events.onSentence = { [weak self] in self?.silenceAt = Date() }
        events.onDone = { [weak self] final in
            self?.wrote(final)
            self?.teardown()
        }
        events.onFailure = { [weak self] message in
            guard let self else { return }
            // No batch fallback yet (see the note at the top). Say what happened
            // and keep whatever closed sentences already landed — their audio has
            // been transcribed, so they are the user's words and not a guess.
            self.callbacks.onNotice("听写中断：\(message)")
            self.teardown()
        }

        guard let socket = AsrSocket(root: root, sessionId: sessionId, key: key, events: events) else {
            callbacks.onNotice("听写地址无效")
            active = false
            self.source = nil
            callbacks.onActive(false, nil)
            callbacks.onFinished()
            return
        }
        self.socket = socket

        let capture = VoiceCapture(
            onChunk: { [weak self] data in
                // The tap runs on CoreAudio's thread; everything else here is
                // main-actor. Hop once, at the boundary.
                Task { @MainActor [weak self] in self?.socket?.send(data) }
            },
            onLevel: { [weak self] level in
                Task { @MainActor [weak self] in self?.heard(level) }
            })
        do {
            try capture.start()
            self.capture = capture
        } catch {
            callbacks.onNotice(error.localizedDescription)
            socket.close()
            self.socket = nil
            active = false
            self.source = nil
            callbacks.onActive(false, nil)
            callbacks.onFinished()
            return
        }

        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tick() }
        }
    }

    // MARK: - Ending

    /// Finish: close the mic, ask the server to flush, and let `onDone` land the
    /// last words. The draft keeps everything this run wrote.
    func stop() {
        guard active else { return }
        capture?.stop()
        capture = nil
        callbacks.onLevel(0)
        socket?.stop()
        // The socket answers with `done`; `teardown` runs from there. If it never
        // does, `stop()` on the socket has its own 12-second timeout.
    }

    /// Throw the run away, including what it put in the draft.
    func cancel() {
        guard active else { return }
        capture?.stop()
        capture = nil
        socket?.close()
        socket = nil
        callbacks.onLevel(0)
        // Take back exactly what was written. The composer folds an empty tail
        // the same way the web does — the base comes back with its separator
        // trimmed, so the user's own text is left as they typed it.
        callbacks.onTail("")
        teardown()
    }

    // MARK: - Inside

    private func wrote(_ text: String) {
        tail = text
        callbacks.onTail(text)
    }

    private func heard(_ level: Double) {
        callbacks.onLevel(level)
        // Anything above room tone counts as still talking. The threshold is
        // deliberately low: the cost of a false "still talking" is thirty more
        // seconds of an open mic the user can see, and the cost of a false
        // silence is a run that ends mid-sentence.
        if level > 0.06 { silenceAt = Date() }
    }

    private func tick() {
        guard active else { return }
        if Date().timeIntervalSince(startedAt) > Self.runMax {
            callbacks.onNotice("听写已达 20 分钟上限")
            stop()
            return
        }
        if Date().timeIntervalSince(silenceAt) > Self.silenceStop { stop() }
    }

    private func teardown() {
        timer?.invalidate()
        timer = nil
        capture?.stop()
        capture = nil
        socket = nil
        active = false
        source = nil
        callbacks.onLevel(0)
        callbacks.onActive(false, nil)
        callbacks.onFinished()
    }
}
