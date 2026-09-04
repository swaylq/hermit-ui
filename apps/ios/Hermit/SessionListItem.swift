import Foundation

/// One row of `chat.listSessions`, as the server sends it.
///
/// Only the fields the list DRAWS are declared. The payload carries a dozen more
/// (`groupId`, the resolved backend, `rssMb`, `contextTokens`); leaving them out
/// is not laziness but the same rule the server applies to itself — that route
/// polls every 5s on every page, and a field nothing renders is a field nobody
/// can notice going wrong. They go in when a screen shows them.
///
/// Every date is optional and every flag is optional for the reason
/// `SessionRuntime` gives: a missing field must read as "cannot say".
struct SessionListItem: Decodable, Hashable, Identifiable {
    var id: String
    var agentName: String
    var title: String?
    /// The denormalized first-user-message excerpt the sidebar falls back to.
    var preview: String?
    var startedAt: Date
    var lastMessageAt: Date?
    var lastReadAt: Date?
    var closedAt: Date?
    var hiddenAt: Date?
    var hibernatedAt: Date?
    var restartRequestedAt: Date?
    var alive: Bool?
    var state: String?
    var snapshotAt: Date?
    /// Precomputed on the server out of the `activity` blob, which never rides
    /// this payload.
    var backgroundBusy: Bool?
    var backgroundNote: String?

    init(id: String, agentName: String, title: String? = nil, preview: String? = nil,
         startedAt: Date, lastMessageAt: Date? = nil, lastReadAt: Date? = nil,
         closedAt: Date? = nil, hiddenAt: Date? = nil, hibernatedAt: Date? = nil,
         restartRequestedAt: Date? = nil, alive: Bool? = nil, state: String? = nil,
         snapshotAt: Date? = nil, backgroundBusy: Bool? = nil, backgroundNote: String? = nil) {
        self.id = id
        self.agentName = agentName
        self.title = title
        self.preview = preview
        self.startedAt = startedAt
        self.lastMessageAt = lastMessageAt
        self.lastReadAt = lastReadAt
        self.closedAt = closedAt
        self.hiddenAt = hiddenAt
        self.hibernatedAt = hibernatedAt
        self.restartRequestedAt = restartRequestedAt
        self.alive = alive
        self.state = state
        self.snapshotAt = snapshotAt
        self.backgroundBusy = backgroundBusy
        self.backgroundNote = backgroundNote
    }

    /// The subset `sessionStatusView` judges. Built here rather than at each call
    /// site so the row and any later screen cannot feed it different facts.
    var statusRow: SessionRuntime {
        SessionRuntime(
            alive: alive, state: state, snapshotAt: snapshotAt, activity: nil,
            backgroundBusy: backgroundBusy, backgroundNote: backgroundNote,
            lastMessageAt: lastMessageAt, closedAt: closedAt,
            restartRequestedAt: restartRequestedAt
        )
    }

    /// `lib/session-read.ts` — newest message newer than the last read. Never
    /// spoken in → never unread; never read but spoken in → unread.
    var unread: Bool {
        guard let msg = lastMessageAt else { return false }
        return msg.timeIntervalSince1970 > (lastReadAt?.timeIntervalSince1970 ?? 0)
    }

    /// `lib/session-recency.ts` — the ONE key the list sorts and prints by. The
    /// server has already sorted by it, so nothing here re-sorts; this is only
    /// the half the row displays.
    var recencyAt: Date { lastMessageAt ?? startedAt }

    /// `s.title || s.preview || s.agentName`, with JavaScript's falsiness: an
    /// EMPTY title falls through to the preview, it does not print as a blank
    /// row. Getting this wrong is invisible in every test that uses a non-empty
    /// title, and a brand-new session has exactly the empty one.
    var displayTitle: String {
        for candidate in [title, preview] {
            if let c = candidate, !c.isEmpty { return c }
        }
        return agentName
    }
}

/// The web's own text formatting, ported where a native screen prints the same
/// string. Nothing here is a judgement — that lives in `SessionStatus`.
enum WebFormat {
    /// `lib/format.ts` `relTime`. Whole units, no rounding up, `-` for nothing
    /// and `future` for a clock skew — all three of which the sidebar can show
    /// today, so all three come across.
    static func relTime(_ d: Date?, now: Date = Date()) -> String {
        guard let d else { return "-" }
        let s = (now.timeIntervalSince1970 - d.timeIntervalSince1970).rounded(.down)
        if s < 0 { return "future" }
        if s < 60 { return "\(Int(s))s ago" }
        if s < 3600 { return "\(Int((s / 60).rounded(.down)))m ago" }
        if s < 86400 { return "\(Int((s / 3600).rounded(.down)))h ago" }
        return "\(Int((s / 86400).rounded(.down)))d ago"
    }
}
