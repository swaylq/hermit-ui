import ActivityKit
import Foundation

/// Starts, updates and ends the per-session Live Activity, and hands its push
/// tokens to the page.
///
/// Division of labour, and why:
///
/// · **The app starts it.** The moment you send a message the app is frontmost,
///   so starting locally puts the activity on screen with no server round trip.
///   (The server COULD start one with a push-to-start token — that is the only
///   way to raise one while the app is closed. The token for it is collected and
///   registered below so the server can add that later without a new build; the
///   first version does not use it.)
/// · **The server updates it.** This is the whole point. A Live Activity that
///   only its own app can update is frozen the moment you put the phone down,
///   which is exactly when a lock-screen widget is supposed to earn its place.
///   So the activity is requested with `pushType: .token`, and the token goes to
///   the page, which registers it with the machine key it already holds — the
///   same arrangement as the APNs device token (NativeBridge.swift). The shell
///   still holds no credentials.
/// · **The elapsed time updates itself.** `Text(_:style:.timer)` is drawn by the
///   system once a second with nothing behind it. Everything else costs a push,
///   so everything else is event-driven — a turn boundary, a new activity line,
///   a block. Never a clock.
///
/// Main-thread only, like the rest of the bridge's surface: every entry point is
/// a WebKit script message, which WebKit delivers on the main queue.
enum LiveActivityManager {

    /// After this long with no update, the system dims the activity to say "this
    /// may be out of date". Only meaningful while a turn is RUNNING: that is the
    /// state the server keeps refreshing, so silence means something broke.
    /// A blocked turn is genuinely static — it can sit for hours waiting for a
    /// human, and dimming it would be lying about a fact that is still true.
    private static let workingStaleAfter: TimeInterval = 10 * 60
    private static let blockedStaleAfter: TimeInterval = 6 * 60 * 60

    /// How long a finished activity stays on the Lock Screen before it clears
    /// itself. Long enough to catch on the next glance, short enough not to be
    /// litter — and the ordinary push notification already delivered the result,
    /// so this is a second chance to notice, not the only one.
    private static let lingerAfterEnd: TimeInterval = 5 * 60

    // MARK: - Reported to the page

    /// Whether this device can show one at all, and whether the user has left
    /// them switched on (Settings → Hermit → Live Activities). The page asks
    /// before it starts sending, so it can stay quiet on a device that would
    /// throw every request away.
    static func status() -> (supported: Bool, enabled: Bool) {
        (true, ActivityAuthorizationInfo().areActivitiesEnabled)
    }

    // MARK: - Lifecycle

    /// The live activity for a session, if there is one. Reads ActivityKit rather
    /// than a dictionary of our own: activities survive the app being killed, so
    /// after a relaunch ours is the only copy that is gone.
    private static func activity(for sessionId: String) -> Activity<SessionActivityAttributes>? {
        Activity<SessionActivityAttributes>.activities.first { $0.attributes.sessionId == sessionId }
    }

    static func start(
        sessionId: String,
        agentName: String,
        machineName: String?,
        state: SessionActivityAttributes.ContentState,
        onToken: @escaping (String, String, Double) -> Void
    ) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // Already showing this session — a second turn in the same conversation,
        // or a relaunch. Move the existing one rather than stacking a duplicate
        // the user would have to dismiss twice.
        if let live = activity(for: sessionId) {
            update(sessionId: sessionId, state: state)
            _ = live
            return
        }

        let attributes = SessionActivityAttributes(
            sessionId: sessionId, agentName: agentName, machineName: machineName
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: content(for: state),
                pushType: .token
            )
            observeToken(of: activity, sessionId: sessionId, sinceEpoch: state.sinceEpoch, onToken: onToken)
        } catch {
            // Thrown when activities are off, or when the app is in the
            // background without a live one, or when the system's cap is hit.
            // None of those are recoverable here and none should interrupt the
            // chat, so this is a log and nothing else.
            NSLog("[hermit] live activity request failed: \(error)")
        }
    }

    static func update(sessionId: String, state: SessionActivityAttributes.ContentState) {
        guard let activity = activity(for: sessionId) else { return }
        Task { await activity.update(content(for: state)) }
    }

    static func end(sessionId: String, state: SessionActivityAttributes.ContentState?) {
        guard let activity = activity(for: sessionId) else { return }
        let final = state.map { content(for: $0) }
        Task {
            await activity.end(final, dismissalPolicy: .after(Date().addingTimeInterval(lingerAfterEnd)))
        }
    }

    /// Every activity this app has running, ended now. Used when the page says
    /// the key that owns them is gone (a sign-out, a workspace switch): the
    /// content on that lock screen belongs to a machine this device no longer
    /// has any business showing.
    static func endAll() {
        for activity in Activity<SessionActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    // MARK: - Content

    private static func content(
        for state: SessionActivityAttributes.ContentState
    ) -> ActivityContent<SessionActivityAttributes.ContentState> {
        let stale: Date?
        switch SessionPhase(state.phase) {
        case .working: stale = Date().addingTimeInterval(workingStaleAfter)
        case .blocked: stale = Date().addingTimeInterval(blockedStaleAfter)
        case .done, .failed: stale = nil            // finished facts do not go stale
        }
        // relevanceScore orders several activities in the Dynamic Island. A turn
        // that is waiting on a human outranks one that is merely running, which
        // is the same order the colours use.
        let relevance: Double = SessionPhase(state.phase) == .blocked ? 100 : 50
        return ActivityContent(state: state, staleDate: stale, relevanceScore: relevance)
    }

    // MARK: - Push tokens

    /// Per-activity token: what the server addresses an UPDATE to. Arrives
    /// asynchronously a moment after the activity starts, and can be reissued at
    /// any time, so this is a stream and not a one-shot read.
    private static func observeToken(
        of activity: Activity<SessionActivityAttributes>,
        sessionId: String,
        sinceEpoch: Double,
        onToken: @escaping (String, String, Double) -> Void
    ) {
        Task {
            for await data in activity.pushTokenUpdates {
                // The start stamp travels with the token so the server can ADOPT
                // it rather than stamp its own. Both are within a second of each
                // other, but the widget's timer counts from this number and a
                // one-second correction is a visible jump backwards.
                await MainActor.run { onToken(hex(data), sessionId, sinceEpoch) }
            }
        }
    }

    /// App-wide token: what the server would address a START to, for a session
    /// whose turn began while the app was closed. Collected and registered now
    /// even though the server does not use it yet — it is reissued by the system
    /// on its own schedule, so an app that only starts listening once the server
    /// is ready would wait an unknown time for the next one.
    static func observePushToStartToken(_ onToken: @escaping (String) -> Void) {
        guard #available(iOS 17.2, *) else { return }
        Task {
            for await data in Activity<SessionActivityAttributes>.pushToStartTokenUpdates {
                await MainActor.run { onToken(hex(data)) }
            }
        }
    }

    private static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
