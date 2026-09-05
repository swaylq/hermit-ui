import AVFoundation
import Foundation

/// The microphone, as 16 kHz mono PCM16 blocks and a loudness number.
///
/// The native half of `apps/dashboard/src/lib/voice-capture.ts`, and the reason
/// this shell exists at all: WebKit on iOS never persists a `getUserMedia`
/// grant, so the web layer is re-prompted on every cold launch and again about
/// ten minutes after each capture. Here the app owns the grant, iOS remembers
/// it, and the prompt happens once.
///
/// ## What is deliberately not copied
///
/// The web keeps the mic warm for 20 seconds after a run (`WARM_HOLD_MS`) to
/// hide `getUserMedia`'s device-open latency, which clips the first syllables.
/// That latency is a browser-permission round trip; `AVAudioEngine.start()` on
/// an already-configured session is milliseconds, so the warm window would be a
/// live microphone indicator kept on for nothing. The audio SESSION is left
/// configured between runs, which is the part that actually costs time.
///
/// ## Why a converter and not a downsample by hand
///
/// The hardware format is whatever the route says — 48 kHz on the phone, 44.1
/// through some Bluetooth headsets, and it CHANGES when a headset is plugged in
/// mid-run. `AVAudioConverter` is the only thing that resamples correctly for
/// all of them; picking every third sample is aliasing, and ASR hears aliasing
/// as consonants that were never said.
final class VoiceCapture {
    /// What `/api/asr` wants, and what `dashscope` is configured for.
    static let sampleRate: Double = 16_000

    /// One block of 16 kHz mono PCM16, little-endian — ready for the socket.
    private let onChunk: (Data) -> Void
    /// RMS of the block, 0…1, for the blob and the dot.
    private let onLevel: (Double) -> Void

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var running = false

    /// The format everything downstream is written against.
    private static let target = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                              sampleRate: VoiceCapture.sampleRate,
                                              channels: 1,
                                              interleaved: true)!

    init(onChunk: @escaping (Data) -> Void, onLevel: @escaping (Double) -> Void) {
        self.onChunk = onChunk
        self.onLevel = onLevel
    }

    // MARK: - Permission

    /// Would opening the mic right now put a system alert on screen?
    ///
    /// The web's `canOpenMicSilently()`, and the answer the press-and-hold needs
    /// SYNCHRONOUSLY at touch-down — before it knows whether the finger is
    /// holding or scrolling. Unlike the browser's, this answer does not expire.
    static var authorized: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    static var denied: Bool {
        AVAudioApplication.shared.recordPermission == .denied
    }

    /// Ask. Safe to call when already granted (it answers immediately).
    ///
    /// Fired from the RELEASE of a hold, never from under a held finger: an
    /// alert raised there swallows the touch and the release that would have
    /// ended the run never arrives. That is the web's rule too, for the same
    /// reason and a different alert.
    static func requestAccess() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    // MARK: - Running

    /// Open the mic and start delivering blocks.
    ///
    /// Throws rather than failing quietly: every caller has something to say to
    /// the user, and a run that silently records nothing is the failure this
    /// whole feature is least able to survive.
    func start() throws {
        guard !running else { return }

        let session = AVAudioSession.sharedInstance()
        // `.playAndRecord` and not `.record`: a turn's reply can start speaking
        // (Live Activity sounds, and the page's own audio) while dictation is
        // open, and `.record` silences all of it. `.duckOthers` is what the
        // system does to a phone call's other audio, which is the closest thing
        // to what is happening here.
        try session.setCategory(.playAndRecord,
                                mode: .spokenAudio,
                                options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true, options: [])

        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        // A zero sample rate is what the input node reports when the route is not
        // ready yet — starting a converter against it crashes inside CoreAudio
        // rather than throwing.
        guard format.sampleRate > 0 else { throw VoiceCaptureError.noInput }
        sourceFormat = format
        converter = AVAudioConverter(from: format, to: Self.target)
        guard converter != nil else { throw VoiceCaptureError.noConverter }

        // 100 ms of audio per block at the SOURCE rate. Small enough that the
        // first partial arrives while you are still speaking, large enough that
        // the socket is not writing sixty times a second.
        let frames = AVAudioFrameCount(format.sampleRate / 10)
        input.installTap(onBus: 0, bufferSize: frames, format: format) { [weak self] buffer, _ in
            self?.handle(buffer)
        }
        engine.prepare()
        try engine.start()
        running = true
    }

    /// Close the mic. Idempotent, and safe from any thread.
    func stop() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        // Hand the route back so other audio comes out of its duck. Not fatal if
        // it fails — the tap is already gone, so nothing is still listening.
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    var isRunning: Bool { running }

    // MARK: - The tap

    private func handle(_ buffer: AVAudioPCMBuffer) {
        guard let converter, let sourceFormat else { return }
        onLevel(Self.rms(buffer))

        // Capacity for the resampled block, rounded up: 48000 → 16000 is exact,
        // 44100 → 16000 is not, and one frame short throws away a millisecond of
        // every block for the length of the run.
        let ratio = Self.sampleRate / sourceFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: Self.target, frameCapacity: capacity) else { return }

        var handed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            // Exactly one input buffer per output block; saying `.haveData`
            // twice would hand the same audio over twice.
            if handed { status.pointee = .noDataNow; return nil }
            handed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0,
              let channel = out.int16ChannelData else { return }
        let bytes = Int(out.frameLength) * MemoryLayout<Int16>.size
        onChunk(Data(bytes: channel[0], count: bytes))
    }

    /// Root mean square, scaled so ordinary speech lands around 0.3–0.7.
    ///
    /// The same shape as the web's `publishMicLevel`: what this drives is a blob
    /// that breathes, so it wants to look like loudness rather than be a
    /// measurement. Read off the SOURCE buffer, before conversion, so a
    /// converter that fails still leaves the blob moving.
    private static func rms(_ buffer: AVAudioPCMBuffer) -> Double {
        guard let data = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let n = Int(buffer.frameLength)
        var sum: Double = 0
        for i in 0..<n {
            let v = Double(data[0][i])
            sum += v * v
        }
        let level = (sum / Double(n)).squareRoot()
        // × 6 and clamped: raw RMS on a phone mic sits under 0.1 for normal
        // speech, and a blob that never grows says the mic is dead.
        return min(1, level * 6)
    }
}

enum VoiceCaptureError: LocalizedError {
    case noInput
    case noConverter

    var errorDescription: String? {
        switch self {
        case .noInput: return "麦克风不可用"
        case .noConverter: return "麦克风格式不支持"
        }
    }
}
