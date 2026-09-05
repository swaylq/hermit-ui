import Foundation

/// One session as `chat.getSession` sends it — the payload behind the chat
/// header.
///
/// A different route from the one the session list reads, and deliberately so:
/// `chat.listSessions` is a 5s poll for every page and carries no `activity`
/// blob at all (the server's own P1-2 payload rule), while this one is asked for
/// only by the session someone has open. The rich state line — "Bash · 47s",
/// "retrying 2/5" — exists only here.
///
/// Only the fields the header DRAWS are declared, the same rule
/// `SessionListItem` follows: the payload carries a dozen more (`rssMb`,
/// `livePreview`, the whole takeover group), and a field nothing renders is a
/// field nobody can notice going wrong. They go in when a screen shows them.
///
/// `runtime` / `runtimeProvider` / `runtimeModel` / `runtimeCredentialId` are
/// the RESOLVED backend, not the row's raw columns — the server spreads
/// `resolveRuntime` over its answer, because a session whose own runtime is null
/// inherits the agent's and the header has to name the one that will actually
/// run the next turn.
struct SessionMeta: Decodable {
    var id: String
    var agentName: String
    var title: String?
    var preview: String?
    var startedAt: Date?
    var lastMessageAt: Date?
    var closedAt: Date?
    var hiddenAt: Date?
    var hibernatedAt: Date?
    var restartRequestedAt: Date?
    var alive: Bool?
    var state: String?
    var snapshotAt: Date?
    var contextTokens: Int?
    var runtime: String?
    var runtimeProvider: String?
    var runtimeModel: String?
    var runtimeCredentialId: String?
    /// The opaque JSON column, decoded as far as it goes. See `MaybeActivity`.
    var activity: MaybeActivity?

    init(id: String, agentName: String, title: String? = nil, preview: String? = nil,
         startedAt: Date? = nil, lastMessageAt: Date? = nil, closedAt: Date? = nil,
         hiddenAt: Date? = nil, hibernatedAt: Date? = nil, restartRequestedAt: Date? = nil,
         alive: Bool? = nil, state: String? = nil, snapshotAt: Date? = nil,
         contextTokens: Int? = nil, runtime: String? = nil, runtimeProvider: String? = nil,
         runtimeModel: String? = nil, runtimeCredentialId: String? = nil,
         activity: MaybeActivity? = nil) {
        self.id = id
        self.agentName = agentName
        self.title = title
        self.preview = preview
        self.startedAt = startedAt
        self.lastMessageAt = lastMessageAt
        self.closedAt = closedAt
        self.hiddenAt = hiddenAt
        self.hibernatedAt = hibernatedAt
        self.restartRequestedAt = restartRequestedAt
        self.alive = alive
        self.state = state
        self.snapshotAt = snapshotAt
        self.contextTokens = contextTokens
        self.runtime = runtime
        self.runtimeProvider = runtimeProvider
        self.runtimeModel = runtimeModel
        self.runtimeCredentialId = runtimeCredentialId
        self.activity = activity
    }

    /// `activity` is an opaque JSON column: an object, a string, an array or
    /// null, written by four producers over a year. Anything `SessionActivity`
    /// cannot describe decodes to nil, which is the same "cannot say" the web
    /// reaches by shape-checking — and crucially it does not fail the whole
    /// payload, which would blank the header over a field it only decorates.
    struct MaybeActivity: Decodable {
        let value: SessionActivity?
        init(from decoder: Decoder) throws { value = try? SessionActivity(from: decoder) }
    }

    /// The subset `sessionStatusView` judges, built here so the header and any
    /// later screen cannot feed it different facts.
    ///
    /// `backgroundBusy` / `backgroundNote` are nil and stay nil: the server
    /// precomputes those two onto the LIST payload only. Nothing is lost — they
    /// are derived from this same `activity` blob, which the list does not carry
    /// and this does, so `SessionStatus` reaches the same answer from the
    /// original rather than from the server's summary of it.
    var statusRow: SessionRuntime {
        SessionRuntime(
            alive: alive, state: state, snapshotAt: snapshotAt, activity: activity?.value,
            backgroundBusy: nil, backgroundNote: nil,
            lastMessageAt: lastMessageAt, closedAt: closedAt,
            restartRequestedAt: restartRequestedAt
        )
    }

    /// `lib/chat-header.ts` `chatHeaderTitle`, ported.
    ///
    /// Static and nil-tolerant because the header paints before `getSession`
    /// answers — that first frame is the one the id fallback exists for. The
    /// ladder is JavaScript's `||`, so an EMPTY title falls through to the
    /// preview rather than printing a blank screen name, which is exactly the
    /// state a brand-new session is in.
    ///
    /// `slice(0, 8)` counts UTF-16 code units on the web; session ids are cuids
    /// and cannot contain anything but ASCII, but the port says `utf16` anyway —
    /// the one thing a fixture cannot check is the case that never occurs, and
    /// getting it right costs a line.
    static func headerTitle(_ meta: SessionMeta?, sessionId: String) -> String {
        for candidate in [meta?.title, meta?.preview, meta?.agentName] {
            if let c = candidate, !c.isEmpty { return c }
        }
        let units = Array(sessionId.utf16)
        return String(decoding: units.prefix(8), as: UTF16.self)
    }
}
