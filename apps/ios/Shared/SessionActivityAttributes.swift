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

        /// How full this session's context window is, 0–100, or nil when no turn
        /// has completed yet.
        ///
        /// A rounded INTEGER percent, and deliberately not the token count the
        /// desktop shows beside it. The count moves every time the gateway reads
        /// usage — at `412.0k` resolution that is a new value every few seconds,
        /// and every new value is an APNs push. The percent moves at most a
        /// hundred times in a session's life. This is the same cut the sidebar
        /// already makes for tight rows (`CtxBar variant="compact"`).
        ///
        /// Rendered even when nil, as `ctx —`: "ctx 占比任何状态都要显示".
        var ctxPct: Int?

        /// APNs caps a Live Activity payload at 4KB and there is no error when it
        /// is exceeded — the update is dropped silently. Both writers (the app and
        /// the server) truncate to this, which leaves room to spare.
        static let maxLine = 120
    }
}
