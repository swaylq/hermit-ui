//  ChatCache.swift
//
//  The phone's local copy of the machine's prose, and the search over it.
//
//  This is the native answer to apps/dashboard/src/lib/chat-cache/{db,search-core}.ts.
//  The web keeps every message of every session in IndexedDB (~11 MB on the
//  production machine) and searches it with a linear `indexOf` scan, because no
//  mainstream JavaScript full-text library tokenizes Chinese — they all split on
//  whitespace, which turns a Chinese sentence into one enormous token and makes
//  a two-character query match nothing.
//
//  SQLite has an answer JavaScript did not: the FTS5 `trigram` tokenizer, which
//  indexes every three-character window and therefore has no idea what a word
//  is. On a 20,000-row Chinese corpus it returns EXACTLY the rows `indexOf`
//  returns, in a tenth of the time; `unicode61`, the default, returns zero rows
//  for every Chinese query. That measurement is `tools/cache-fixture.sh`.
//
//  IT HAS ONE HOLE, AND IT IS THE COMMON CASE. A trigram index cannot answer a
//  query shorter than three characters — not with an error, with SILENCE: zero
//  rows, no message. Chinese queries are routinely two characters. So anything
//  shorter than three characters is answered by the same linear scan the web
//  does (`searchByScan` below), which is not a regression, just not the win.
//
//  WHAT THE INDEX IS AND IS NOT ALLOWED TO DECIDE. FTS5 narrows; it never
//  answers. Every row it returns is re-checked in Swift with the web's own
//  matching rule, and the offsets that drive the snippet come from that check —
//  so a tokenizer that folds case more eagerly than JavaScript can cost time,
//  never correctness.
//
//  NO CREDENTIALS: this file opens a file and runs SQL. It has no network, no
//  Keychain, and no idea what a machine key is.

import Foundation
import SQLite3

/// `sqlite3_bind_text` with a pointer SQLite must copy, not borrow. Swift's
/// String bridging gives a buffer that dies at the end of the call.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// MARK: - Rows

/// One message's searchable prose. Mirrors `CachedText` in chat-cache/types.ts.
struct CachedText: Equatable {
    let id: String
    let sessionId: String
    let role: String
    /// ISO-8601, kept as a STRING — same as the web, and for the same reason:
    /// it is a sort key here, never arithmetic. Parsing it into a Date would
    /// make the phone's ordering depend on a formatter agreeing with V8.
    let createdAt: String
    let text: String
    /// Renderable blocks that carry no prose — interaction cards. Absent for
    /// the overwhelming majority of rows. Stored as the JSON the server sent,
    /// unparsed: this layer never renders, it only has to hand back what it was
    /// given (M4 owns the block schema).
    let blocksJSON: String?
    /// `nil`/absent = the human, `brain` = the Brain during a takeover,
    /// `system` = a gateway poke. Without it a conversation the Brain drove
    /// reads back as if the human had said all of it.
    let authoredBy: String?

    init(
        id: String,
        sessionId: String,
        role: String,
        createdAt: String,
        text: String,
        blocksJSON: String? = nil,
        authoredBy: String? = nil
    ) {
        self.id = id
        self.sessionId = sessionId
        self.role = role
        self.createdAt = createdAt
        self.text = text
        self.blocksJSON = blocksJSON
        self.authoredBy = authoredBy
    }
}

/// A search hit: the message, plus where in its text the query matched.
/// Mirrors `SearchHit` in chat-cache/types.ts.
struct SearchHit: Equatable {
    let id: String
    let sessionId: String
    let role: String
    let createdAt: String
    /// A window of text around the FIRST match.
    let snippet: String
    /// Match ranges relative to `snippet`, in UTF-16 code units — the units the
    /// web's offsets are in (they index a JavaScript string), and the units
    /// `NSRange` and `NSAttributedString` want on this side. Making them
    /// Character offsets would render differently from the browser the first
    /// time an emoji or a flag appeared before a match.
    let ranges: [Range<Int>]
    let truncatedLeft: Bool
    let truncatedRight: Bool
    /// Matches within THIS message, capped at `WebContract.maxMatchesPerRow`.
    let matchCount: Int
}

struct SearchResult: Equatable {
    let query: String
    let hits: [SearchHit]
    /// Matches across all messages, even beyond the returned page.
    let totalHits: Int
    /// Messages containing at least one match.
    let totalMessages: Int
    /// How many messages the corpus holds in this scope, for the "indexing…"
    /// hint. NOT the same measurement as the web's, which counts rows it
    /// actually walked — the whole point here is that the index means most rows
    /// are never touched. The hint it feeds reads the same either way.
    let scanned: Int
}

struct SearchOptions {
    /// `0` = every match. The overlay pages at `WebContract.searchPageSize`; the
    /// in-session find asks for all of them, because ↑/↓ has to say "3 / 47".
    var limit: Int = WebContract.searchPageSize
    /// Restrict to one session (the in-session find).
    var sessionId: String?
    /// Restrict to a set of sessions (the overlay's agent filter). The caller
    /// resolves agent → sessions; prose rows carry no agent name.
    var sessionIds: [String]?
    enum Order { case newest, chronological }
    /// `.newest` for the overlay — recency is the only ranking a chat log
    /// supports. `.chronological` for the in-session find, so ↑/↓ walk the
    /// conversation the way the timeline scrolls.
    var order: Order = .newest

    init(limit: Int = WebContract.searchPageSize,
         sessionId: String? = nil,
         sessionIds: [String]? = nil,
         order: Order = .newest) {
        self.limit = limit
        self.sessionId = sessionId
        self.sessionIds = sessionIds
        self.order = order
    }
}

// MARK: - Errors

struct ChatCacheError: Error, CustomStringConvertible {
    let message: String
    /// The SQLite result code, when there was one. Kept in the text as well:
    /// swallowing it turns "the disk is full" and "you wrote bad SQL" into the
    /// same unactionable failure, which is a mistake this project has already
    /// made once with `SecItem` (`Keychain.swift`).
    let code: Int32?

    var description: String { message }

    init(_ message: String, code: Int32? = nil) {
        self.message = code.map { "\(message) (sqlite \($0))" } ?? message
        self.code = code
    }
}

// MARK: - The store

/// One SQLite database per workspace scope.
///
/// SCOPING mirrors the web's: the file name carries the workspace identity
/// (machine id, plus the agent name for a scoped share key), so switching
/// workspaces opens a DIFFERENT database that cannot read the previous one. It
/// is a convenience boundary, not the security boundary — the server still
/// scopes every query by the request's key.
///
/// Not thread-safe by itself: one connection, and SQLite's own serialization is
/// not a substitute for the caller knowing which queue it is on. M3/M4 own it
/// from a single actor.
final class ChatCache {

    /// `scopeId(machineId, agentName)` from chat-cache/db.ts, character for
    /// character — a scope string that disagrees would silently start a second,
    /// empty cache instead of finding the existing one.
    static func scopeId(machineId: String, agentName: String? = nil) -> String {
        if let agentName, !agentName.isEmpty { return "\(machineId)::\(agentName)" }
        return machineId
    }

    private var db: OpaquePointer?
    let path: URL

    /// Bumped when the STORED SHAPE changes. A projection change — the web's
    /// version 2, where `text` rows gained `blocks` — is not a schema change but
    /// still needs the bookkeeping wiped, because a delta sync only refetches
    /// what MOVED and old rows would keep their old shape forever. So both kinds
    /// bump this, and `sessions` is emptied on any bump: the next pass then
    /// plans a full fetch for everything, which is exactly `planSync`'s
    /// "not cached" branch doing the repair.
    static let schemaVersion = 1

    // MARK: Opening

    /// Opens (creating if needed) the cache for one scope.
    ///
    /// `directory` defaults to Application Support. Not the Caches directory:
    /// iOS may evict Caches under storage pressure, and an evicted prose layer
    /// is a silent 11 MB refetch on cellular. Excluded from iCloud backup for
    /// the same reason the browser's copy is not backed up — it is all
    /// re-derivable from the server.
    static func open(scope: String, in directory: URL? = nil) throws -> ChatCache {
        let dir = try directory ?? defaultDirectory()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(fileSafe(scope)).sqlite")
        return try ChatCache(path: file)
    }

    static func defaultDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var dir = base.appendingPathComponent("ChatCache", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }

    /// A scope is a machine id and possibly an agent name, and an agent name is
    /// whatever the user typed. `/` and `:` in a file name are not survivable,
    /// and a name that differed only by case would collide on a case-insensitive
    /// volume — so anything outside a conservative set is percent-escaped, which
    /// is reversible and therefore cannot map two scopes onto one file.
    static func fileSafe(_ scope: String) -> String {
        var out = ""
        for byte in Array(scope.utf8) {
            let c = Character(UnicodeScalar(byte))
            if c.isLetter && c.isASCII || c.isNumber && c.isASCII || c == "-" || c == "_" || c == "." {
                out.append(c)
            } else {
                out += String(format: "%%%02X", byte)
            }
        }
        return out.isEmpty ? "default" : out
    }

    init(path: URL) throws {
        self.path = path
        var handle: OpaquePointer?
        let rc = sqlite3_open_v2(
            path.path, &handle,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard rc == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open \(path.lastPathComponent)"
            sqlite3_close_v2(handle)
            throw ChatCacheError(message, code: rc)
        }
        self.db = handle
        do {
            try migrate()
        } catch {
            sqlite3_close_v2(handle)
            self.db = nil
            throw error
        }
    }

    deinit { sqlite3_close_v2(db) }

    func close() {
        sqlite3_close_v2(db)
        db = nil
    }

    // MARK: Schema

    private func migrate() throws {
        // WAL so a background sync writing does not block the timeline reading.
        // `journal_mode` is persistent and returns a row, so it is a query.
        _ = try? scalarText("PRAGMA journal_mode=WAL")
        try exec("PRAGMA foreign_keys=ON")

        // FTS5 is compiled into Apple's libsqlite3, but "is compiled in" is a
        // claim, and a claim about a system library is worth one CREATE. Doing
        // it here rather than at the first search means an old OS fails while
        // there is still a caller to tell, not in the middle of a query.
        try exec("""
            CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

            CREATE TABLE IF NOT EXISTS sessions (
              sessionId TEXT PRIMARY KEY,
              agentName TEXT NOT NULL,
              title     TEXT,
              preview   TEXT,
              watermark INTEGER NOT NULL,
              count     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS prose (
              id         TEXT PRIMARY KEY,
              sessionId  TEXT NOT NULL,
              role       TEXT NOT NULL,
              createdAt  TEXT NOT NULL,
              text       TEXT NOT NULL,
              blocks     TEXT,
              authoredBy TEXT
            );
            CREATE INDEX IF NOT EXISTS prose_by_session ON prose(sessionId);
            CREATE INDEX IF NOT EXISTS prose_by_time ON prose(createdAt, id);

            CREATE VIRTUAL TABLE IF NOT EXISTS prose_fts USING fts5(
              text,
              content='prose',
              content_rowid='rowid',
              tokenize='trigram'
            );
            """)

        // External content: the index holds trigrams, the prose stays in one
        // place. Triggers keep them level.
        //
        // The writes below are upserts, never `INSERT OR REPLACE` — REPLACE
        // resolves a conflict by DELETING the old row, and SQLite fires delete
        // triggers for that only when `recursive_triggers` is on, which it is
        // not by default. The index would keep the old text forever and search
        // would answer with prose that is no longer in the table.
        try exec("""
            CREATE TRIGGER IF NOT EXISTS prose_ai AFTER INSERT ON prose BEGIN
              INSERT INTO prose_fts(rowid, text) VALUES (new.rowid, new.text);
            END;
            CREATE TRIGGER IF NOT EXISTS prose_ad AFTER DELETE ON prose BEGIN
              INSERT INTO prose_fts(prose_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
            END;
            CREATE TRIGGER IF NOT EXISTS prose_au AFTER UPDATE ON prose BEGIN
              INSERT INTO prose_fts(prose_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
              INSERT INTO prose_fts(rowid, text) VALUES (new.rowid, new.text);
            END;
            """)

        let stored = Int(try scalarText("SELECT v FROM meta WHERE k='schemaVersion'") ?? "") ?? 0
        if stored != Self.schemaVersion {
            try exec("DELETE FROM prose; DELETE FROM sessions;")
            try exec("INSERT INTO meta(k, v) VALUES ('schemaVersion', '\(Self.schemaVersion)') "
                     + "ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        }
    }

    // MARK: Sessions

    /// The bookkeeping half of `planSync`'s input, in insertion order — which
    /// `planSync` reproduces into `drop`, so it must be an ordered read.
    /// `rowid` is the insertion order SQLite already keeps.
    func sessions() throws -> [CachedSession] {
        try rows("SELECT sessionId, agentName, title, preview, watermark, count FROM sessions ORDER BY rowid") { s in
            CachedSession(
                sessionId: Self.text(s, 0) ?? "",
                agentName: Self.text(s, 1) ?? "",
                title: Self.text(s, 2),
                preview: Self.text(s, 3),
                watermark: Int(sqlite3_column_int64(s, 4)),
                count: Int(sqlite3_column_int64(s, 5)))
        }
    }

    func putSession(_ session: CachedSession) throws {
        try run("""
            INSERT INTO sessions(sessionId, agentName, title, preview, watermark, count)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(sessionId) DO UPDATE SET
              agentName = excluded.agentName, title = excluded.title,
              preview = excluded.preview, watermark = excluded.watermark,
              count = excluded.count
            """) { s in
            Self.bind(s, 1, session.sessionId)
            Self.bind(s, 2, session.agentName)
            Self.bind(s, 3, session.title)
            Self.bind(s, 4, session.preview)
            sqlite3_bind_int64(s, 5, Int64(session.watermark))
            sqlite3_bind_int64(s, 6, Int64(session.count))
        }
    }

    /// Forget a session entirely: its bookkeeping AND its prose. Both, always —
    /// dropping only the bookkeeping leaves its messages in the corpus, so
    /// search keeps returning hits in a conversation that no longer exists and
    /// tapping one goes nowhere.
    func dropSession(_ sessionId: String) throws {
        try transaction {
            try run("DELETE FROM prose WHERE sessionId = ?") { Self.bind($0, 1, sessionId) }
            try run("DELETE FROM sessions WHERE sessionId = ?") { Self.bind($0, 1, sessionId) }
        }
    }

    /// Wipe one session's prose without forgetting it — `SyncPlan.Fetch.reset`.
    func resetSessionText(_ sessionId: String) throws {
        try run("DELETE FROM prose WHERE sessionId = ?") { Self.bind($0, 1, sessionId) }
    }

    // MARK: Prose

    /// One transaction for the whole batch. A page is a thousand rows and each
    /// one costs three index writes; committing per row turns a sync pass into
    /// a thousand fsyncs.
    func putTextRows(_ rows: [CachedText]) throws {
        guard !rows.isEmpty else { return }
        try transaction {
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            let sql = """
                INSERT INTO prose(id, sessionId, role, createdAt, text, blocks, authoredBy)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  sessionId = excluded.sessionId, role = excluded.role,
                  createdAt = excluded.createdAt, text = excluded.text,
                  blocks = excluded.blocks, authoredBy = excluded.authoredBy
                """
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
                throw lastError("preparing the prose insert")
            }
            for r in rows {
                sqlite3_reset(stmt)
                sqlite3_clear_bindings(stmt)
                Self.bind(stmt, 1, r.id)
                Self.bind(stmt, 2, r.sessionId)
                Self.bind(stmt, 3, r.role)
                Self.bind(stmt, 4, r.createdAt)
                Self.bind(stmt, 5, r.text)
                Self.bind(stmt, 6, r.blocksJSON)
                Self.bind(stmt, 7, r.authoredBy)
                guard sqlite3_step(stmt) == SQLITE_DONE else {
                    throw lastError("writing prose row \(r.id)")
                }
            }
        }
    }

    func textCount() throws -> Int {
        Int(try scalarText("SELECT count(*) FROM prose") ?? "0") ?? 0
    }

    func textCount(sessionId: String) throws -> Int {
        var out = 0
        _ = try rows("SELECT count(*) FROM prose WHERE sessionId = ?", bind: { Self.bind($0, 1, sessionId) }) { (s: OpaquePointer) -> Int in
            out = Int(sqlite3_column_int64(s, 0))
            return 0
        }
        return out
    }

    /// Every row of one session, oldest first — what M3 paints a reopened
    /// conversation from before the network answers.
    func text(sessionId: String) throws -> [CachedText] {
        try rows(
            "SELECT id, sessionId, role, createdAt, text, blocks, authoredBy FROM prose "
            + "WHERE sessionId = ? ORDER BY createdAt, id",
            bind: { Self.bind($0, 1, sessionId) },
            map: Self.cachedText)
    }

    // MARK: Search

    /// Substring search over the cached prose, with the web's matching rule.
    ///
    /// The index only narrows. Whatever comes back is re-checked here with the
    /// same `indexOf` walk `search-core.ts` does, and the offsets from that walk
    /// are what the snippet is cut with — so the phone highlights the same
    /// characters the browser does.
    func search(_ query: String, options: SearchOptions = SearchOptions()) throws -> SearchResult {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            return SearchResult(query: q, hits: [], totalHits: 0, totalMessages: 0, scanned: 0)
        }

        let fold = Self.needsCaseFold(q)
        let needle = fold ? q.lowercased() : q
        let qLen = q.utf16.count

        // Three paths, narrowing to the same answer:
        //   · the trigram index, when it can hold the query at all;
        //   · a LIKE scan, when SQLite's ASCII case folding is the same folding
        //     the web does;
        //   · every row in scope, when it is not — the web's own behaviour.
        let candidates: [CachedText]
        if Self.canUseIndex(q) {
            candidates = try searchByIndex(q, options: options)
        } else if Self.foldsTheSameWayAsSQLite(q) {
            candidates = try searchByScan(needle, options: options)
        } else {
            candidates = try allRows(options: options)
        }

        var matched: [(row: CachedText, offsets: [Int])] = []
        var totalHits = 0
        for row in candidates {
            let hay = fold ? row.text.lowercased() : row.text
            let offsets = Self.findMatches(in: hay, needle: needle)
            if offsets.isEmpty { continue }
            totalHits += offsets.count
            matched.append((row, offsets))
        }

        // Recency is the only ranking a chat log supports. Ties break on id, so
        // two rows written in the same millisecond do not swap between passes.
        //
        // Sorted here rather than in SQL: the scan path and the index path
        // return rows in different orders, and one comparison in one place is
        // easier to keep honest than an ORDER BY in each — the rows that survive
        // the offset walk are already down to a page's worth in every realistic
        // query.
        let chronological = options.order == .chronological
        matched.sort { a, b in
            let c = Self.compare(a.row, b.row)
            return chronological ? c < 0 : c > 0
        }

        let page = options.limit > 0 ? Array(matched.prefix(options.limit)) : matched
        return SearchResult(
            query: q,
            hits: page.map { Self.buildHit(row: $0.row, offsets: $0.offsets, qLen: qLen) },
            totalHits: totalHits,
            totalMessages: matched.count,
            scanned: try corpusSize(options: options))
    }

    /// Whether the trigram index can answer this query AT ALL.
    ///
    /// Two independent reasons it cannot, and both are silent — zero rows, no
    /// error — which is why this is a guard and not a `catch`:
    ///
    ///  1. Fewer than three characters. A trigram index holds no window shorter
    ///     than three, so it has nothing to look up. Chinese queries are
    ///     routinely two characters ("义脑"), so this is the common case, not
    ///     the edge one.
    ///  2. A cased letter outside ASCII (Greek, Cyrillic, Turkish İ). The web
    ///     folds case with `String.prototype.toLowerCase`, which is full
    ///     Unicode; what SQLite's tokenizer folds is its own business and is not
    ///     part of any contract this project controls. Rather than depend on two
    ///     foldings agreeing, hand those queries to the scan.
    static func canUseIndex(_ q: String) -> Bool {
        q.count >= 3 && foldsTheSameWayAsSQLite(q)
    }

    /// Whether SQLite may be trusted to narrow this query.
    ///
    /// SQLite folds case for ASCII and nothing else, without ICU; JavaScript's
    /// `toLowerCase` is full Unicode. For a query whose cased letters are all
    /// ASCII the two agree, and anything extra SQLite lets through is thrown out
    /// by the offset walk anyway. For a query with a Greek, Cyrillic or Turkish
    /// letter they do not, and the miss would be SILENT — fewer rows, no error.
    /// Those go to the unfiltered scan.
    ///
    /// (The remaining hole is on the TEXT side: `'\u{212A}'.toLowerCase()` is
    /// `k`, so the web would match a Kelvin sign against a query of `k` and this
    /// will not. There are a handful of such characters in Unicode, none of them
    /// in a chat log, and closing it costs a full scan on every query.)
    static func foldsTheSameWayAsSQLite(_ q: String) -> Bool {
        for ch in q where !ch.isASCII && ch.lowercased() != ch.uppercased() { return false }
        return true
    }

    private func searchByIndex(_ q: String, options: SearchOptions) throws -> [CachedText] {
        var sql = """
            SELECT p.id, p.sessionId, p.role, p.createdAt, p.text, p.blocks, p.authoredBy
            FROM prose_fts f JOIN prose p ON p.rowid = f.rowid
            WHERE prose_fts MATCH ?
            """
        var ids: [String] = []
        if let one = options.sessionId { ids.append(one) }
        if let many = options.sessionIds { ids.append(contentsOf: many) }
        if options.sessionId != nil || options.sessionIds != nil {
            if ids.isEmpty { return [] }
            sql += " AND p.sessionId IN (\(Array(repeating: "?", count: ids.count).joined(separator: ",")))"
        }
        // The whole query as ONE phrase, so the trigrams have to be adjacent —
        // that is what makes a trigram match a substring match rather than a bag
        // of three-character windows. Doubling `"` is the only escape FTS5 needs
        // inside a phrase; `*`, `-`, `NEAR` and the rest are literal in there.
        let phrase = "\"" + q.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        return try rows(sql, bind: { s in
            Self.bind(s, 1, phrase)
            for (i, id) in ids.enumerated() { Self.bind(s, Int32(i + 2), id) }
        }, map: Self.cachedText)
    }

    /// The fallback, and the web's only path: look at every row.
    ///
    /// `LIKE` and not `instr`, because `LIKE` is the one SQLite optimizes when
    /// the column happens to be trigram-indexed; the semantics we rely on
    /// (ASCII-case-insensitive substring) are the same either way, and the
    /// offsets are recomputed in Swift regardless.
    private func searchByScan(_ needle: String, options: SearchOptions) throws -> [CachedText] {
        var sql = """
            SELECT id, sessionId, role, createdAt, text, blocks, authoredBy
            FROM prose WHERE text LIKE ? ESCAPE '\\'
            """
        var ids: [String] = []
        if let one = options.sessionId { ids.append(one) }
        if let many = options.sessionIds { ids.append(contentsOf: many) }
        if options.sessionId != nil || options.sessionIds != nil {
            if ids.isEmpty { return [] }
            sql += " AND sessionId IN (\(Array(repeating: "?", count: ids.count).joined(separator: ",")))"
        }
        let pattern = "%" + Self.escapeLike(needle) + "%"
        return try rows(sql, bind: { s in
            Self.bind(s, 1, pattern)
            for (i, id) in ids.enumerated() { Self.bind(s, Int32(i + 2), id) }
        }, map: Self.cachedText)
    }

    /// No prefilter at all: hand every row in scope to the Swift matcher. Used
    /// only for a query SQLite would fold differently, which on this corpus is
    /// never — but "never" is a claim about the user's language, not about the
    /// code.
    private func allRows(options: SearchOptions) throws -> [CachedText] {
        var sql = "SELECT id, sessionId, role, createdAt, text, blocks, authoredBy FROM prose"
        var ids: [String] = []
        if let one = options.sessionId { ids.append(one) }
        if let many = options.sessionIds { ids.append(contentsOf: many) }
        if options.sessionId != nil || options.sessionIds != nil {
            if ids.isEmpty { return [] }
            sql += " WHERE sessionId IN (\(Array(repeating: "?", count: ids.count).joined(separator: ",")))"
        }
        return try rows(sql, bind: { s in
            for (i, id) in ids.enumerated() { Self.bind(s, Int32(i + 1), id) }
        }, map: Self.cachedText)
    }

    private func corpusSize(options: SearchOptions) throws -> Int {
        var ids: [String] = []
        if let one = options.sessionId { ids.append(one) }
        if let many = options.sessionIds { ids.append(contentsOf: many) }
        if options.sessionId == nil && options.sessionIds == nil { return try textCount() }
        if ids.isEmpty { return 0 }
        let sql = "SELECT count(*) FROM prose WHERE sessionId IN (\(Array(repeating: "?", count: ids.count).joined(separator: ",")))"
        var out = 0
        _ = try rows(sql, bind: { s in
            for (i, id) in ids.enumerated() { Self.bind(s, Int32(i + 1), id) }
        }) { (s: OpaquePointer) -> Int in
            out = Int(sqlite3_column_int64(s, 0))
            return 0
        }
        return out
    }

    // MARK: The web's matching rule, ported

    /// `needsCaseFold` — folding only matters if the query has a character whose
    /// case can differ. A no-op for Han, Kana, digits and punctuation, which is
    /// most of this corpus.
    static func needsCaseFold(_ query: String) -> Bool {
        query.lowercased() != query.uppercased()
    }

    /// `findMatches` — every non-overlapping occurrence, as UTF-16 offsets.
    ///
    /// Non-overlapping: the search resumes at `i + needle.count`, so "aa" in
    /// "aaa" is ONE match, not two. That is the web's answer and it is what the
    /// "3 / 47" counter counts.
    static func findMatches(in haystack: String, needle: String, cap: Int = WebContract.maxMatchesPerRow) -> [Int] {
        guard !needle.isEmpty else { return [] }
        let hay = Array(haystack.utf16)
        let ndl = Array(needle.utf16)
        guard ndl.count <= hay.count else { return [] }
        var out: [Int] = []
        var i = 0
        let last = hay.count - ndl.count
        while i <= last && out.count < cap {
            var k = 0
            while k < ndl.count && hay[i + k] == ndl[k] { k += 1 }
            if k == ndl.count {
                out.append(i)
                i += ndl.count
            } else {
                i += 1
            }
        }
        return out
    }

    /// `buildHit` — a window around the FIRST match, with every match that lands
    /// inside it rebased to snippet coordinates.
    static func buildHit(row: CachedText, offsets: [Int], qLen: Int) -> SearchHit {
        let units = Array(row.text.utf16)
        let first = offsets[0]
        let start = max(0, first - WebContract.snippetPad)
        let end = min(units.count, first + qLen + WebContract.snippetPad)
        // The window is cut in UTF-16 units, so it can land between the halves
        // of a surrogate pair — an emoji 70 characters before the match. Taking
        // it as a String would replace the orphan with U+FFFD; nudging the edge
        // by one unit keeps the pair whole and costs one character of context.
        var lo = start, hi = end
        if lo > 0 && lo < units.count && Self.isLowSurrogate(units[lo]) { lo += 1 }
        if hi > 0 && hi < units.count && Self.isLowSurrogate(units[hi]) { hi -= 1 }
        let snippet = String(utf16CodeUnits: Array(units[lo..<max(lo, hi)]), count: max(0, max(lo, hi) - lo))
        var ranges: [Range<Int>] = []
        for o in offsets where o >= start && o + qLen <= end {
            ranges.append((o - lo)..<(o - lo + qLen))
        }
        return SearchHit(
            id: row.id,
            sessionId: row.sessionId,
            role: row.role,
            createdAt: row.createdAt,
            snippet: snippet,
            ranges: ranges,
            truncatedLeft: start > 0,
            truncatedRight: end < units.count,
            matchCount: offsets.count)
    }

    private static func isLowSurrogate(_ u: UInt16) -> Bool { (0xDC00...0xDFFF).contains(u) }

    /// `cmpRow` — (createdAt, id), both compared as strings. `<` on Swift
    /// Strings is Unicode-ordered and JavaScript's is UTF-16-code-unit-ordered;
    /// they agree for the ASCII these two fields hold (an ISO-8601 timestamp and
    /// a cuid) and this is the only place that would notice if a future id
    /// stopped being ASCII.
    static func compare(_ a: CachedText, _ b: CachedText) -> Int {
        if a.createdAt != b.createdAt { return a.createdAt < b.createdAt ? -1 : 1 }
        if a.id == b.id { return 0 }
        return a.id < b.id ? -1 : 1
    }

    /// `%`, `_` and the escape character itself, for a `LIKE` pattern.
    static func escapeLike(_ s: String) -> String {
        var out = ""
        for ch in s {
            if ch == "%" || ch == "_" || ch == "\\" { out.append("\\") }
            out.append(ch)
        }
        return out
    }

    // MARK: - SQLite plumbing

    private func lastError(_ what: String) -> ChatCacheError {
        let code = sqlite3_errcode(db)
        let message = String(cString: sqlite3_errmsg(db))
        return ChatCacheError("\(what): \(message)", code: code)
    }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &err)
        if rc != SQLITE_OK {
            let message = err.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(err)
            throw ChatCacheError(message, code: rc)
        }
    }

    private func run(_ sql: String, bind: (OpaquePointer) -> Void = { _ in }) throws {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw lastError("preparing \(Self.firstLine(sql))")
        }
        bind(stmt)
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else {
            throw lastError("running \(Self.firstLine(sql))")
        }
    }

    private func rows<T>(
        _ sql: String,
        bind: (OpaquePointer) -> Void = { _ in },
        map: (OpaquePointer) -> T
    ) throws -> [T] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw lastError("preparing \(Self.firstLine(sql))")
        }
        bind(stmt)
        var out: [T] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_ROW { out.append(map(stmt)); continue }
            if rc == SQLITE_DONE { break }
            throw lastError("reading \(Self.firstLine(sql))")
        }
        return out
    }

    /// One integer out of one row. The app has typed accessors; this exists so
    /// `tools/cache-fixture.sh` can interrogate a control table built with a
    /// different tokenizer without a second SQLite wrapper.
    func scalarInt(_ sql: String) throws -> Int {
        try rows(sql) { Int(sqlite3_column_int64($0, 0)) }.first ?? 0
    }

    private func scalarText(_ sql: String) throws -> String? {
        try rows(sql) { Self.text($0, 0) }.first ?? nil
    }

    func transaction(_ body: () throws -> Void) throws {
        try exec("BEGIN IMMEDIATE")
        do {
            try body()
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    private static func firstLine(_ sql: String) -> String {
        sql.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? sql
    }

    private static func bind(_ stmt: OpaquePointer, _ index: Int32, _ value: String?) {
        if let value {
            sqlite3_bind_text(stmt, index, value, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, index)
        }
    }

    private static func text(_ stmt: OpaquePointer, _ column: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, column) else { return nil }
        return String(cString: c)
    }

    private static func cachedText(_ s: OpaquePointer) -> CachedText {
        CachedText(
            id: text(s, 0) ?? "",
            sessionId: text(s, 1) ?? "",
            role: text(s, 2) ?? "",
            createdAt: text(s, 3) ?? "",
            text: text(s, 4) ?? "",
            blocksJSON: text(s, 5),
            authoredBy: text(s, 6))
    }
}
