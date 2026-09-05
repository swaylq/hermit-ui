import Foundation

/// The composer's pure decisions, ported from
/// `apps/dashboard/src/components/chat/composer-core.ts`.
///
/// Five of them, and none is a judgement call: what the box says, whether the
/// circle is live, when an optimistic bubble retires, whether a turn is running,
/// and whether the Stop pill is up. Every one is held against the web's own
/// answers by `tools/composer-fixture.sh`, so where the web is surprising the
/// surprise is copied and the fixture is what proves it was copied rather than
/// reasoned about.
///
/// Sibling of `WebLabels` (the header's vocabulary) and `WebFormat` (a session
/// row's). Foundation only — no UIKit, no SwiftUI, nothing that needs a screen.
enum ComposerCore {

    // MARK: - Constants the web owns

    /// `QUEUE_LIMIT` — the most WAITING messages a session may hold. Only ever
    /// printed here (the server enforces it); the fixture holds the number.
    static let queueLimit = 5

    /// `DELIVERY_GRACE_MS` — how long a snapshot may predate a message it has in
    /// fact already picked up. `turnInFlight` will not call a turn settled until
    /// the snapshot is past the message by more than this.
    static let deliveryGraceMs: Double = 4000

    /// The 90 second escape hatch in `turnInFlight`, for the case where no
    /// snapshot ever arrives. Not a named constant on the web either — it is
    /// written `90_000` inline — so the fixture is what ties the two together.
    static let staleTurnMs: Double = 90_000

    /// `CLIENT_ID_RE.source` from `lib/chat-queue.ts`. Carried as a STRING and
    /// checked against the fixture rather than compiled: see `isValidClientId`
    /// for why this is not run through `NSRegularExpression`.
    static let clientIdPattern = "^[A-Za-z0-9._:-]{1,128}$"

    // MARK: - JavaScript's trim

    /// The exact set `String.prototype.trim` strips: the ECMA-262 `WhiteSpace`
    /// production (TAB, VT, FF, SP, NBSP, ZWNBSP, and every Unicode `Zs`) plus
    /// `LineTerminator` (LF, CR, LS, PS).
    ///
    /// Written out rather than taken from `CharacterSet.whitespacesAndNewlines`,
    /// which is close and not equal: **U+FEFF** is `Cf` in Unicode and therefore
    /// NOT in that set, while JavaScript strips it. A message pasted out of a
    /// Windows-authored file commonly starts with one, and the difference decides
    /// whether an optimistic bubble ever finds its real row.
    private static let jsWhitespace: Set<Unicode.Scalar> = [
        "\u{0009}", "\u{000A}", "\u{000B}", "\u{000C}", "\u{000D}",
        "\u{0020}", "\u{00A0}", "\u{1680}",
        "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}",
        "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}",
        "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
    ]

    /// `String.prototype.trim`. Scalar-wise on purpose: the web trims UTF-16 code
    /// units and every character in the set above is one scalar, so trimming by
    /// scalar reaches the same answer without Swift's grapheme clustering pulling
    /// a combining mark along with the space in front of it.
    static func jsTrim(_ s: String) -> String {
        var scalars = Array(s.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end, jsWhitespace.contains(scalars[start]) { start += 1 }
        while end > start, jsWhitespace.contains(scalars[end - 1]) { end -= 1 }
        if start == 0 && end == scalars.count { return s }
        scalars = Array(scalars[start..<end])
        var out = String.UnicodeScalarView()
        for u in scalars { out.append(u) }
        return String(out)
    }

    /// `msgText` from `components/chat/lib.ts`: every TEXT block's prose, joined
    /// and trimmed. Only text — joining anything else in is what would let a
    /// match run across a block boundary, and it is also what would make an
    /// agent's own `tool_result` row look like something the user typed.
    static func msgText(_ content: JSONValue) -> String {
        jsTrim(ContentBlock.parseAll(content).map(\.text).joined())
    }

    // MARK: - Optimistic-row handoff

    /// One bubble the screen is showing on the strength of a send that has not
    /// come back yet.
    struct Optimistic: Equatable {
        /// Local id — `pending-<clock>-<random>` on the web, the clientId here.
        var id: String
        /// The server id `chat.send` answered with, once it has.
        var realId: String?
        /// What was typed, as content blocks, so `msgText` reads it the same way
        /// it reads a real row.
        var content: JSONValue
    }

    /// Which optimistic bubbles are still standing, given what the server has.
    ///
    /// By `realId` once the send has answered: text matching breaks under
    /// outgoing auto-translate, where the bubble holds the typed Chinese and the
    /// real row is English, so the two never meet and the stub lingers. Text is
    /// the fallback for the window BEFORE the send responds, and it is a
    /// BUDGET — each real row claims at most one bubble, so the same sentence
    /// sent twice in a row leaves one of the two standing rather than retiring
    /// both against one arrival.
    static func dropLanded(_ optimistic: [Optimistic],
                           landed real: [(id: String, content: JSONValue)]) -> [Optimistic] {
        if optimistic.isEmpty { return optimistic }
        let ids = Set(real.map(\.id))
        var texts: [String: Int] = [:]
        for m in real { texts[msgText(m.content), default: 0] += 1 }
        return optimistic.filter { p in
            if let realId = p.realId { return !ids.contains(realId) }
            let t = msgText(p.content)
            let left = texts[t] ?? 0
            if left == 0 { return true }
            texts[t] = left - 1
            return false
        }
    }

    // MARK: - What the box says

    /// Everything the placeholder ladder reads.
    struct Face: Equatable {
        /// The session is closed.
        var disabled = false
        /// An interaction card upstream is waiting on a tap.
        var awaitingInput = false
        /// `queueLen >= queueLimit`.
        var queueFull = false
        /// A turn is running (`stopPill`'s `turnRunning`).
        var working = false
        var uploadingCount = 0
        var dictating = false
        /// Touch-primary pointer. Always true on a phone, and the reason this
        /// field exists at all is that the web asks.
        var touch = false
        /// The Brain is composing in this box, so its ghost text owns the space.
        var brainGhost = false
    }

    /// The placeholder ladder, top rung first. The ORDER is the whole content:
    /// a closed session outranks a full queue, and `working` sits under both so
    /// "↵ to queue next" is never offered where queueing would fail.
    static func placeholder(_ f: Face) -> String {
        if f.brainGhost { return "" }
        if f.disabled { return "session is closed" }
        if f.awaitingInput { return "↑ respond above to continue" }
        if f.queueFull { return "queue full (\(queueLimit)) · waiting for current turn" }
        if f.working { return "working… ↵ to queue next" }
        if f.uploadingCount > 0 { return "uploading \(f.uploadingCount)…" }
        if f.dictating { return "listening…" }
        return f.touch ? "Ask anything · hold to talk" : "Ask anything"
    }

    /// Whether the send circle is live. `working` is deliberately NOT read: a
    /// message typed during a running turn is queued, not refused.
    static func canSend(disabled: Bool, awaitingInput: Bool, queueFull: Bool,
                        uploadingCount: Int, draft: String, readyAttachments: Int) -> Bool {
        !disabled && !awaitingInput && !queueFull && uploadingCount == 0
            && (!jsTrim(draft).isEmpty || readyAttachments > 0)
    }

    // MARK: - Is a turn running?

    /// The four timestamps `turnInFlight` reads. Milliseconds since the epoch,
    /// the way JavaScript counts, so the fixture's numbers are the same numbers.
    struct TurnSignals: Equatable {
        /// The merged poll + push status row's `state`, or nil when there is none.
        var statusState: String?
        /// That row's `snapshotAt`, or nil.
        var snapshotAt: Double?
        /// The newest SERVER row's role, or nil when the window is empty.
        var lastRole: String?
        /// …and that row's `createdAt`.
        var lastAt: Double?
        /// The newest OPTIMISTIC row's `createdAt`, or nil when there is none.
        /// Its mere existence means the newest message is the user's.
        var optimisticAt: Double?
        /// The tail assistant row grew within the last ~1.8s.
        var streamingTail = false
        var now: Double
    }

    struct Flight: Equatable {
        var waitingAssistant: Bool
        var inFlight: Bool
    }

    /// The local, message-shaped half of "a turn is running": the newest row is
    /// a user message nobody has answered, or the tail assistant row is still
    /// growing.
    ///
    /// Both inequalities are STRICT, and both matter. A snapshot landing exactly
    /// `deliveryGraceMs` after the message is not yet proof the gateway saw it;
    /// a message exactly 90s old has not yet earned the escape hatch.
    static func turnInFlight(_ s: TurnSignals) -> Flight {
        let lastMsgIsUser = s.optimisticAt != nil ? true : s.lastRole == "user"
        let lastMsgTime = s.optimisticAt ?? s.lastAt ?? 0
        let snapTime = s.snapshotAt ?? 0
        let turnSettled = s.statusState == "idle"
            && (snapTime > lastMsgTime + deliveryGraceMs || s.now - lastMsgTime > staleTurnMs)
        let waiting = lastMsgIsUser && !turnSettled
        return Flight(waitingAssistant: waiting, inFlight: waiting || s.streamingTail)
    }

    struct Stop: Equatable {
        var turnRunning: Bool
        var show: Bool
    }

    /// Whether the composer shows its Stop pill — and the `turnRunning` behind
    /// it, which the header and the back gesture read too.
    ///
    /// NOT `inFlight` alone. That is a local heuristic and it goes false
    /// whenever the agent is busy WITHOUT emitting, which is precisely a long
    /// tool call: a session sitting in a multi-minute Bash read "working" in the
    /// header while the composer offered no way to stop it.
    /// `statusKey == "working"` is the union — `SessionStatus.view` ORs the fast
    /// local signal with the gateway's pane-derived state — so this is a strict
    /// superset and cannot hide Stop anywhere it used to show. The cost is a
    /// stale snapshot leaving Stop up for a few seconds after a turn ends;
    /// pressing it then sends Escape to an idle pane, which does nothing.
    static func stopPill(inFlight: Bool, statusKey: String, closed: Bool) -> Stop {
        let running = inFlight || statusKey == "working"
        return Stop(turnRunning: running, show: running && !closed)
    }

    // MARK: - The idempotency key

    /// The charset `chat.send` accepts for `clientId`, as a set rather than as a
    /// compiled pattern.
    ///
    /// `NSRegularExpression` would be the obvious way to honour
    /// `clientIdPattern` and it is the wrong one: it is ICU, where `$` matches
    /// before a FINAL line terminator as well as at the end of input. JavaScript's
    /// `$` (no `/m`) means end of input and nothing else, so `"abc\n"` is a legal
    /// id to ICU and a rejected one to the server. The fixture carries that pair.
    ///
    /// Length is counted in UTF-16 code units, which is what a JS regex quantifier
    /// counts. Nothing in the charset is outside the BMP, so this only ever
    /// differs for ids that are refused anyway — it is spelled out so the next
    /// person does not have to work that out.
    private static func isClientIdChar(_ u: UInt16) -> Bool {
        switch u {
        case 0x41...0x5A, 0x61...0x7A, 0x30...0x39: return true   // A-Z a-z 0-9
        case 0x2E, 0x5F, 0x3A, 0x2D: return true                   // . _ : -
        default: return false
        }
    }

    /// Would the server accept this as a `chat.send` idempotency key?
    static func isValidClientId(_ s: String) -> Bool {
        let units = Array(s.utf16)
        guard (1...128).contains(units.count) else { return false }
        return units.allSatisfy(isClientIdChar)
    }

    /// A fresh idempotency key for one composed message.
    ///
    /// `<install>:<millis>-<random>`. The install id is what makes two devices
    /// unable to collide; the rest is what makes one device unable to collide
    /// with itself inside a millisecond. A UUID alone would do, but the shape is
    /// worth keeping legible in a Postgres row a human is reading at 2am.
    ///
    /// Hyphens are in the charset, so a raw `UUID().uuidString` is already legal.
    /// Lowercased for the same reason the rest of the app's ids are.
    static func newClientId(install: String = InstallIdentity.id, now: Date = Date()) -> String {
        let millis = UInt64(max(0, now.timeIntervalSince1970 * 1000))
        let salt = String(UInt32.random(in: 0..<UInt32.max), radix: 36)
        let id = "\(install):\(millis)-\(salt)"
        // Truncation rather than a throw: an install id long enough to break the
        // cap is a bug in whoever wrote it, and losing the tail of a random salt
        // is a far better outcome than a send the server refuses. Cut in UTF-16
        // units for the same reason the check counts them.
        guard id.utf16.count > 128 else { return id }
        return String(decoding: Array(id.utf16.prefix(128)), as: UTF16.self)
    }
}

/// This install's stable id — one UUID, minted on first use and kept.
///
/// Kept apart from `ComposerCore` because it is the one piece of it that TOUCHES
/// something: `UserDefaults`. The fixture runner compiles `ComposerCore` and
/// passes an install id in, so nothing under test has to reach for storage.
enum InstallIdentity {
    private static let key = "hermit.installId"

    static var id: String {
        if let s = UserDefaults.standard.string(forKey: key), !s.isEmpty { return s }
        let fresh = UUID().uuidString.lowercased()
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }
}

/// The composer's draft, per session, surviving the app being killed.
///
/// `hermit:draft:<sid>` in `localStorage` on the web, written on EVERY keystroke
/// (`useEffect(() => saveDraft(sessionId, draft), [sessionId, draft])`), removed
/// when the draft empties. `UserDefaults` is the same bargain here: small
/// strings, synchronous reads, and a write that coalesces before it reaches the
/// disk — so per-keystroke is as cheap as it is there.
///
/// The KEY is deliberately the web's, character for character. Both halves of
/// this app open the same sessions on the same phone, and a draft typed in the
/// web view is a draft the native composer should find. (The web's copy lives in
/// WKWebView's own local storage, so today they are two stores with one key
/// shape; making them one store is a bridge call, and its own checklist line.)
enum ComposerDraft {
    static func key(_ sessionId: String) -> String { "hermit:draft:\(sessionId)" }

    static func load(_ sessionId: String) -> String {
        UserDefaults.standard.string(forKey: key(sessionId)) ?? ""
    }

    static func save(_ sessionId: String, _ value: String) {
        if value.isEmpty {
            UserDefaults.standard.removeObject(forKey: key(sessionId))
        } else {
            UserDefaults.standard.set(value, forKey: key(sessionId))
        }
    }
}
