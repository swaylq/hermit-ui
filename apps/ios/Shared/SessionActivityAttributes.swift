import ActivityKit
import Foundation

/// What a Live Activity for one chat session carries.
///
/// Compiled into BOTH targets (the app starts activities, the widget extension
/// draws them), so it must not import anything either one lacks.
///
/// The shape is chosen around one question: standing at a lock screen, what do
/// you need in order to decide whether to pick the phone up? Four things, in
/// this order — is it waiting on ME, which session is it, what is it doing, and
/// how long has it been. Everything else was left out; a Live Activity that
/// needs reading is a Live Activity that gets swiped away.
struct SessionActivityAttributes: ActivityAttributes {
    /// Fixed for the life of the activity — set once when it starts.
    /// A change to any of these needs a NEW activity, so nothing here may be a
    /// thing that legitimately changes mid-turn.
    let sessionId: String
    let agentName: String
    /// The machine the agent lives on. Nil when the device holds one key and the
    /// answer would be noise; the views hide the whole line then.
    let machineName: String?

    struct ContentState: Codable, Hashable {
        /// The states worth a different glance. Encoded as a string rather than
        /// an enum with a raw value because the SERVER writes this field into an
        /// APNs `content-state` payload, and a server that learns a fifth state
        /// before the installed app does must not fail to decode the other four.
        /// `Phase(rawValue:)` falls back to `.working` — see below.
        var phase: String
        /// The session's own title. Static in practice, but it is auto-titled a
        /// few seconds INTO the first turn, so it cannot live in the attributes.
        var title: String
        /// One line of what is happening. While working, the activity line the
        /// gateway already produces ("Read 12 files", "Running pnpm build"); when
        /// blocked, the question being asked; when done, the reply's first line.
        /// Budget: see `maxLine`.
        var line: String
        /// When the CURRENT phase began, as Unix epoch SECONDS. The views render
        /// it as a system timer, which ticks once a second with no push behind
        /// it — the only part of this that is free to keep live.
        ///
        /// A `Double`, not a `Date`, on purpose. This struct is decoded from two
        /// places: ActivityKit inside the app (Swift's own encoder, which writes
        /// a `Date` as seconds since 2001) and the system's decoder for an APNs
        /// `content-state` payload the SERVER hand-wrote in JSON. Those two do
        /// not agree on what a bare number means, and the disagreement is 31
        /// years with no error anywhere — the timer would simply show a wrong
        /// number. An explicit epoch has one meaning on both sides.
        var sinceEpoch: Double

        /// The moment the phase began.
        var since: Date { Date(timeIntervalSince1970: sinceEpoch) }
        /// Messages waiting behind the running one (the composer's queue). Nil
        /// and zero both render as nothing.
        var queued: Int?

        /// APNs caps a Live Activity payload at 4KB and there is no error when it
        /// is exceeded — the update is dropped silently. Both writers (the app and
        /// the server) truncate to this, which leaves room to spare.
        static let maxLine = 120
    }
}

/// The phases, with a decode that cannot fail.
///
/// The app ships through TestFlight and the server ships continuously, so the
/// server WILL at some point send a phase this build has never heard of. Falling
/// back to `.working` is deliberate: the wrong-but-plausible state is a running
/// turn, and an activity stuck on "working" still shows the line and the timer,
/// which is most of the value. Falling back to `.done` would end the thing.
enum SessionPhase: String {
    /// A turn is running.
    case working
    /// The agent stopped and is waiting for a human answer — a permission
    /// decision, or a question it asked. The only phase that earns an alert.
    case blocked
    /// The turn finished. `line` carries the first line of what it said.
    case done
    /// The turn ended badly (a crash, a timeout, a cancelled run).
    case failed

    init(_ raw: String) { self = SessionPhase(rawValue: raw) ?? .working }
}
