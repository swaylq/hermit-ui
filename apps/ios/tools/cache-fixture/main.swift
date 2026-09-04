//  cache-fixture — drives ChatCache.swift and SyncPlan.swift with no simulator,
//  no key and no network. About four seconds.
//
//      apps/ios/tools/cache-fixture.sh
//
//  Four things it proves, in order:
//
//   1. `planSync` answers every case in fixtures/sync-plan-cases.json exactly as
//      the TypeScript did when that file was generated.
//   2. `ChatCache.search` answers every case in fixtures/search-cases.json
//      exactly as `searchCorpus` did — same snippet, same highlight ranges,
//      same counts. (`scanned` excepted, and said so out loud below.)
//   3. The FTS5 trigram index and a linear scan return THE SAME ROWS on a
//      Chinese corpus, and `unicode61` — the default — returns none of them.
//      This is the measurement the comment at the top of ChatCache.swift makes.
//   4. Rewriting and deleting a row leaves the index level with the table. This
//      is the one that catches `INSERT OR REPLACE`, whose delete trigger does
//      not fire unless `recursive_triggers` is on.
//
//  Neither this file nor tools/ is in any Xcode target, so `swiftc -typecheck
//  Hermit/*.swift` cannot see it — a compile error here is only ever found by
//  running it.

import Foundation

// MARK: - Reporting

var failures = 0
var checks = 0

func check(_ ok: Bool, _ what: String, _ detail: @autoclosure () -> String = "") {
    checks += 1
    if ok { return }
    failures += 1
    let d = detail()
    print("  ✗ \(what)" + (d.isEmpty ? "" : "\n      \(d)"))
}

func section(_ title: String) {
    print("\n\(title)")
    print(String(repeating: "─", count: max(8, title.count)))
}

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: root.appendingPathComponent("tools/fixtures/\(name)"))
}

// MARK: - 1. planSync

struct PlanCase: Decodable {
    struct Expected: Decodable {
        struct Fetch: Decodable {
            let probe: ProbeRow
            let since: Int
            let reset: Bool
        }
        let drop: [String]
        let fetch: [Fetch]
        let upToDate: [ProbeRow]
    }
    let name: String
    let probe: [ProbeRow]
    let cached: [CachedSession]
    let expected: Expected
}

struct PlanTable: Decodable { let cases: [PlanCase] }

func runPlanTable() throws {
    section("1. planSync vs the table the web generated")
    let table = try JSONDecoder().decode(PlanTable.self, from: fixture("sync-plan-cases.json"))
    for c in table.cases {
        let got = planSync(probe: c.probe, cached: c.cached)
        check(got.drop == c.expected.drop, "\(c.name): drop",
              "want \(c.expected.drop)  got \(got.drop)")
        check(got.fetch.map(\.probe) == c.expected.fetch.map(\.probe), "\(c.name): fetch order",
              "want \(c.expected.fetch.map(\.probe.sessionId))  got \(got.fetch.map(\.probe.sessionId))")
        check(got.fetch.map(\.since) == c.expected.fetch.map(\.since), "\(c.name): since",
              "want \(c.expected.fetch.map(\.since))  got \(got.fetch.map(\.since))")
        check(got.fetch.map(\.reset) == c.expected.fetch.map(\.reset), "\(c.name): reset",
              "want \(c.expected.fetch.map(\.reset))  got \(got.fetch.map(\.reset))")
        check(got.upToDate == c.expected.upToDate, "\(c.name): upToDate",
              "want \(c.expected.upToDate.map(\.sessionId))  got \(got.upToDate.map(\.sessionId))")
    }
    print("  \(table.cases.count) cases")
}

// MARK: - 2. search

struct SearchTable: Decodable {
    struct Row: Decodable {
        let id: String
        let sessionId: String
        let role: String
        let createdAt: String
        let text: String
    }
    struct Hit: Decodable {
        let id: String
        let sessionId: String
        let role: String
        let createdAt: String
        let snippet: String
        let ranges: [[Int]]
        let truncatedLeft: Bool
        let truncatedRight: Bool
        let matchCount: Int
    }
    struct Expected: Decodable {
        let query: String
        let hits: [Hit]
        let totalHits: Int
        let totalMessages: Int
    }
    struct Options: Decodable {
        let limit: Int?
        let sessionId: String?
        let sessionIds: [String]?
        let order: String?
    }
    struct Case: Decodable {
        let name: String
        let query: String
        let options: Options
        let expected: Expected
    }
    let corpus: [Row]
    let cases: [Case]
}

func tempDir(_ tag: String) throws -> URL {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("hermit-cache-fixture-\(tag)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

func runSearchTable() throws {
    section("2. ChatCache.search vs the table the web generated")
    let table = try JSONDecoder().decode(SearchTable.self, from: fixture("search-cases.json"))
    let dir = try tempDir("search")
    defer { try? FileManager.default.removeItem(at: dir) }
    let cache = try ChatCache.open(scope: "fixture::asst", in: dir)
    try cache.putTextRows(table.corpus.map {
        CachedText(id: $0.id, sessionId: $0.sessionId, role: $0.role, createdAt: $0.createdAt, text: $0.text)
    })
    let landed = try cache.textCount()
    check(landed == table.corpus.count, "corpus landed", "want \(table.corpus.count) got \(landed)")

    for c in table.cases {
        var opts = SearchOptions()
        if let l = c.options.limit { opts.limit = l }
        opts.sessionId = c.options.sessionId
        opts.sessionIds = c.options.sessionIds
        opts.order = c.options.order == "chronological" ? .chronological : .newest
        let got = try cache.search(c.query, options: opts)

        check(got.query == c.expected.query, "\(c.name): query")
        check(got.totalHits == c.expected.totalHits, "\(c.name): totalHits",
              "want \(c.expected.totalHits) got \(got.totalHits)")
        check(got.totalMessages == c.expected.totalMessages, "\(c.name): totalMessages",
              "want \(c.expected.totalMessages) got \(got.totalMessages)")
        check(got.hits.map(\.id) == c.expected.hits.map(\.id), "\(c.name): hit ids and order",
              "want \(c.expected.hits.map(\.id)) got \(got.hits.map(\.id))")
        for (g, w) in zip(got.hits, c.expected.hits) {
            check(g.snippet == w.snippet, "\(c.name): snippet of \(w.id)",
                  "want \(w.snippet.debugDescription)\n      got  \(g.snippet.debugDescription)")
            check(g.ranges.map { [$0.lowerBound, $0.upperBound] } == w.ranges, "\(c.name): ranges of \(w.id)",
                  "want \(w.ranges) got \(g.ranges.map { [$0.lowerBound, $0.upperBound] })")
            check(g.truncatedLeft == w.truncatedLeft, "\(c.name): truncatedLeft of \(w.id)")
            check(g.truncatedRight == w.truncatedRight, "\(c.name): truncatedRight of \(w.id)")
            check(g.matchCount == w.matchCount, "\(c.name): matchCount of \(w.id)",
                  "want \(w.matchCount) got \(g.matchCount)")
            // The highlight has to land on the query inside the snippet the
            // phone will actually draw. Comparing ranges to the web's numbers
            // does not prove that — both could be wrong the same way.
            let units = Array(g.snippet.utf16)
            for r in g.ranges where r.upperBound <= units.count {
                let slice = String(utf16CodeUnits: Array(units[r]), count: r.count)
                check(slice.lowercased() == c.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                      "\(c.name): highlight of \(w.id) covers the query",
                      "highlighted \(slice.debugDescription)")
            }
        }
    }
    print("  \(table.cases.count) cases, corpus of \(table.corpus.count) rows")
    cache.close()
}

// MARK: - 3. the tokenizer measurement

func randomChinese(_ rng: inout SystemRandomNumberGenerator, count: Int) -> String {
    let words = ["义脑", "会话", "模型", "部署", "服务端", "网页", "原生", "时间线", "消息", "缓存",
                 "搜索", "分词", "索引", "查询", "中文", "语料", "线性", "扫描", "毫秒", "本地",
                 "数据库", "迁移", "凭据", "钥匙串", "推送", "锁屏", "卡片", "状态", "颜色", "超时"]
    let latin = ["planSync", "FTS5", "SQLite", "tRPC", "SSE", "watermark", "dashboard", "Hermit"]
    var out = ""
    for _ in 0..<count {
        out += Int.random(in: 0..<100, using: &rng) < 12 ? latin.randomElement()! : words.randomElement()!
    }
    return out + "。"
}

func runTokenizerMeasurement() throws {
    section("3. trigram vs unicode61 vs a linear scan, on Chinese")
    var rng = SystemRandomNumberGenerator()
    let n = 20_000
    var rows: [CachedText] = []
    rows.reserveCapacity(n)
    for i in 0..<n {
        rows.append(CachedText(
            id: "m\(i)", sessionId: "s\(i % 40)", role: "user",
            createdAt: "2026-09-01T00:00:00.000Z",
            text: randomChinese(&rng, count: Int.random(in: 6...30, using: &rng))))
    }
    let chars = rows.reduce(0) { $0 + $1.text.count }

    let dir = try tempDir("bench")
    defer { try? FileManager.default.removeItem(at: dir) }
    let cache = try ChatCache.open(scope: "bench", in: dir)
    var t = Date()
    try cache.putTextRows(rows)
    print(String(format: "  %d rows / %d chars indexed in %.2fs", n, chars, -t.timeIntervalSinceNow))

    // The claim the header makes, checked against a control table that uses the
    // DEFAULT tokenizer over the same prose.
    try cache.exec("CREATE VIRTUAL TABLE control USING fts5(text, tokenize='unicode61')")
    try cache.exec("INSERT INTO control(text) SELECT text FROM prose")

    func controlCount(_ q: String) throws -> Int {
        let phrase = q.replacingOccurrences(of: "\"", with: "\"\"")
        return try cache.scalarInt("SELECT count(*) FROM control WHERE control MATCH '\"\(phrase)\"'")
    }

    for q in ["时间线", "中文语料", "服务端网页", "SQLite"] {
        let truth = rows.filter { $0.text.lowercased().contains(q.lowercased()) }.count
        t = Date()
        let got = try cache.search(q, options: SearchOptions(limit: 0))
        let ms = -t.timeIntervalSinceNow * 1000
        let control = try controlCount(q)
        // RETRIEVAL only, both ways, on the same rows and the same disk. Not
        // `search()` against `LIKE`: `search()` also materializes every matching
        // row and walks it for offsets, which is the same work down either path
        // and swamps the difference the index makes. `count(*)` isolates it.
        let phrase = "\"" + q.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        var t0 = Date()
        let idxCount = try cache.scalarInt(
            "SELECT count(*) FROM prose_fts WHERE prose_fts MATCH '\(phrase)'")
        let idxMs = -t0.timeIntervalSinceNow * 1000
        t0 = Date()
        let likeCount = try cache.scalarInt(
            "SELECT count(*) FROM prose WHERE text LIKE '%' || '\(ChatCache.escapeLike(q))' || '%' ESCAPE '\\'")
        let likeMs = -t0.timeIntervalSinceNow * 1000
        check(got.totalMessages == truth, "trigram agrees with the scan for \(q)",
              "want \(truth) got \(got.totalMessages)")
        check(likeCount == truth, "the LIKE fallback agrees too for \(q)",
              "want \(truth) got \(likeCount)")
        check(idxCount == truth, "the index alone agrees for \(q)",
              "want \(truth) got \(idxCount)")
        print(String(format: "  %@ rows=%-5d  find: trigram %5.1fms  scan %5.1fms   whole search() %5.1fms   unicode61 found %d",
                     q.padding(toLength: 11, withPad: " ", startingAt: 0), truth, idxMs, likeMs, ms, control))
        if q == "时间线" {
            check(control == 0, "unicode61 finds nothing for a Chinese query — the reason trigram is used",
                  "it found \(control), so the header's claim needs rewriting")
        }
    }

    // The hole: under three characters the index holds nothing, so this MUST be
    // going down the scan path. If `canUseIndex` ever says yes here, the answer
    // silently becomes zero.
    let two = "义脑"
    check(ChatCache.canUseIndex(two) == false, "a two-character query does not go to the index")
    t = Date()
    let short = try cache.search(two, options: SearchOptions(limit: 0))
    let shortMs = -t.timeIntervalSinceNow * 1000
    let shortTruth = rows.filter { $0.text.contains(two) }.count
    check(short.totalMessages == shortTruth, "the scan answers the two-character query",
          "want \(shortTruth) got \(short.totalMessages)")
    print(String(format: "  %@ rows=%-5d  find: trigram   n/a    (under three characters)   whole search() %5.1fms",
                 two.padding(toLength: 11, withPad: " ", startingAt: 0), shortTruth, shortMs))
    cache.close()
}

// MARK: - 4. the index stays level with the table

func runIndexCoherence() throws {
    section("4. rewriting and deleting keep the index level with the table")
    let dir = try tempDir("coherence")
    defer { try? FileManager.default.removeItem(at: dir) }
    let cache = try ChatCache.open(scope: "coherence", in: dir)

    let before = "从前的一句话在这里"
    let after = "改写之后的另一句话"
    try cache.putTextRows([CachedText(id: "x1", sessionId: "s", role: "user",
                                      createdAt: "2026-09-01T00:00:00.000Z", text: before)])
    check(try cache.search(before).totalMessages == 1, "the row is findable")

    // Same id, new text. `INSERT OR REPLACE` would leave the OLD text in the
    // index — the delete trigger it needs does not fire without
    // `recursive_triggers`. The upsert this uses fires the update trigger.
    try cache.putTextRows([CachedText(id: "x1", sessionId: "s", role: "user",
                                      createdAt: "2026-09-01T00:00:00.000Z", text: after)])
    check(try cache.search(after).totalMessages == 1, "the new text is findable")
    check(try cache.search(before).totalMessages == 0, "the OLD text is gone from a SEARCH")
    check(try cache.textCount() == 1, "the rewrite did not duplicate the row")

    // …and gone from the INDEX, which is a different claim, and the reason this
    // section exists. `search` joins the index back to `prose` on rowid, so an
    // orphaned index entry is INVISIBLE to it: the query keeps returning the
    // right answer over a corrupt index and the only symptom is a file that
    // grows forever. Swapping the upsert below for `INSERT OR REPLACE` produces
    // exactly that — REPLACE satisfies the constraint by deleting the old row
    // WITHOUT firing the delete trigger (that needs `recursive_triggers`, off by
    // default), then inserts a new one under a NEW rowid, leaving the old
    // rowid's trigrams behind. Every check above still passes when it does.
    func integrityCheck(_ c: ChatCache, _ when: String) {
        do {
            // The argument matters: `integrity-check` on its own — and with a 0 —
            // only verifies the index against ITSELF, which an orphan passes.
            // A 1 compares it against the content table, which is the only form
            // that sees one. (SQLite 3.42+; iOS 17 ships 3.43.)
            try c.exec("INSERT INTO prose_fts(prose_fts, rank) VALUES ('integrity-check', 1)")
            check(true, "the index matches the table \(when)")
        } catch {
            check(false, "the index matches the table \(when)", "\(error)")
        }
    }
    integrityCheck(cache, "after a rewrite")

    try cache.putTextRows([CachedText(id: "x2", sessionId: "s2", role: "user",
                                      createdAt: "2026-09-01T00:00:01.000Z", text: after)])
    try cache.dropSession("s2")
    check(try cache.search(after).totalMessages == 1, "dropping a session takes its prose with it")
    check(try cache.textCount(sessionId: "s2") == 0, "and leaves none of its rows behind")

    try cache.resetSessionText("s")
    check(try cache.search(after).totalMessages == 0, "reset wipes a session's prose")
    check(try cache.textCount() == 0, "and the table agrees")
    integrityCheck(cache, "after a drop and a reset")

    // Reopening has to find the same database, not start a new one.
    try cache.putTextRows([CachedText(id: "x3", sessionId: "s", role: "user",
                                      createdAt: "2026-09-01T00:00:02.000Z", text: after)])
    try cache.putSession(CachedSession(sessionId: "s", agentName: "asst", title: "标题",
                                       preview: nil, watermark: 42, count: 1))
    cache.close()
    let again = try ChatCache.open(scope: "coherence", in: dir)
    check(try again.search(after).totalMessages == 1, "the database survives a close and reopen")
    check(try again.sessions().map(\.sessionId) == ["s"], "so does the bookkeeping")
    check(try again.sessions().first?.watermark == 42, "watermark round-trips")

    // planSync's input, straight out of the store — the seam the two halves of
    // this round meet at.
    let plan = planSync(
        probe: [ProbeRow(sessionId: "s", agentName: "asst", title: "标题", preview: nil, watermark: 99, count: 3)],
        cached: try again.sessions())
    check(plan.fetch.count == 1 && plan.fetch[0].since == 42 && !plan.fetch[0].reset,
          "a moved watermark plans a delta from what the store holds",
          "\(plan)")
    again.close()
}

// MARK: - main

do {
    try runPlanTable()
    try runSearchTable()
    try runTokenizerMeasurement()
    try runIndexCoherence()
} catch {
    print("\nFATAL: \(error)")
    exit(1)
}

print("\n\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
