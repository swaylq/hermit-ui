import Foundation

/// Everything the Lock Screen and the island draw, as plain values.
///
/// Split out from `SessionActivityAttributes` so the views that render it need
/// no ActivityKit — which is iOS-only, and which has no way to build an
/// `ActivityViewContext` outside the system. With the presentation depending on
/// this instead, the same views compile and render anywhere, which is the only
/// way to LOOK at a layout without a device and a live turn.
struct SessionCard {
    let sessionId: String
    let agentName: String
    /// Only when the device drives more than one deployment; a constant is noise.
    let machineName: String?
    let phase: SessionPhase
    let title: String
    /// What it is doing, what it is asking, or how long the turn took.
    let line: String
    /// When the current phase began — the widget's timer counts from here.
    let since: Date
    let queued: Int?
    /// 0–100, or nil before a turn has completed.
    let ctxPct: Int?
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
    /// The turn finished. `line` carries how long it took.
    case done
    /// The turn ended badly (a crash, a timeout, a cancelled run).
    case failed

    init(_ raw: String) { self = SessionPhase(rawValue: raw) ?? .working }
}
