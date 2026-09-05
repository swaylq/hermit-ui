import Foundation

/// "Load earlier", and the rows the live window sheds while it is on screen.
///
/// Port of the pure half of `apps/dashboard/src/components/chat/use-older-pages.ts`.
/// The two sides run against the same fixture table
/// (`tools/fixtures/merge-cases.json`), so a disagreement is a test failure
/// rather than a hole someone finds in a transcript months later.
///
/// ## Why a screen needs this at all
///
/// The live window is a fixed `WebContract.timelineLimit` rows that slides
/// forward as a turn produces messages, and history is a separate list paged in
/// below it. The two are concatenated with nothing checking that they meet — and
/// they stop meeting on their own, because every row the window sheds off its
/// old end belongs to neither list afterwards. Nothing looks wrong; the timeline
/// simply closes over the missing middle, and paging only ever walks further
/// back, so no amount of scrolling brings it back. Measured on the web: 162
/// messages and fifteen minutes gone, with the auto-compaction notice the reader
/// was looking for inside the gap.
///
/// ## What is NOT ported
///
/// `chunksBottomFirst`, which splits a fetched page into 30-row slices. It
/// exists because each slice is a React render whose markdown parse has to stay
/// under a frame, and because the prepend anchor has to re-assert between
/// slices. Neither applies here: the collection view is upside down, so a page
/// of history is an APPEND below the fold — it neither blocks a paint the reader
/// is watching nor moves anything already on screen. Porting it would carry the
/// cost and none of the benefit, the same call `TimelineMerge` made about
/// `rowSig`.
enum TimelinePager {
    /// `(createdAt, id)`, the total order the server pages by — as
    /// `use-older-pages.ts` spells it, which is **not** how `TimelineMerge`
    /// spells it.
    ///
    /// This one compares the ISO strings; `TimelineMerge.before` parses them into
    /// instants. On the timestamps the server actually sends today (superjson
    /// writes `toISOString()`, always three fractional digits) the two agree on
    /// everything. On a bare-second timestamp they do not: `…:00.500Z` sorts
    /// BEFORE `…:00Z` byte-wise, because `.` (0x2E) is below `Z` (0x5A), so this
    /// function would call a row that IS older than the window's edge newer, and
    /// `shed` would drop it instead of handing it to the pager — the same
    /// missing middle the file exists to prevent.
    ///
    /// Copied as-is regardless, and pinned in the fixture's `orderSkew` section.
    /// The divergence lives in the web; making the phone quietly disagree with
    /// the browser is not a fix, it is a second bug that is harder to find.
    static func isOlder(_ a: FoldInput, _ b: FoldInput) -> Bool {
        a.createdAt != b.createdAt ? jsLess(a.createdAt, b.createdAt) : jsLess(a.id, b.id)
    }

    /// JavaScript's `<` on strings: lexicographic over UTF-16 code units.
    ///
    /// Swift's `<` on `String` compares by Unicode canonical equivalence over
    /// grapheme clusters, which is a different answer for anything outside
    /// ASCII. Ids and ISO timestamps are ASCII today, so this is defensive —
    /// but round 19 already shipped a real bug from assuming a Swift string
    /// operation meant what the JavaScript one meant (`.count` vs `.length`),
    /// and one line is cheaper than finding out again.
    private static func jsLess(_ a: String, _ b: String) -> Bool {
        var i = a.utf16.makeIterator()
        var j = b.utf16.makeIterator()
        while true {
            switch (i.next(), j.next()) {
            case (nil, nil): return false
            case (nil, _): return true
            case (_, nil): return false
            case (let x?, let y?):
                if x != y { return x < y }
            }
        }
    }

    /// What the live window dropped off its OLD end between two renders.
    ///
    /// Older than the NEW window's first row, so a row deleted from inside the
    /// window — an undelivered queue row being dequeued, the other thing the
    /// stream's `gone` reports — is still dropped rather than resurrected as
    /// history.
    static func shed(_ prev: [FoldInput], _ next: [FoldInput]) -> [FoldInput] {
        guard let edge = next.first, !prev.isEmpty else { return [] }
        let held = Set(next.map(\.id))
        return prev.filter { !held.contains($0.id) && isOlder($0, edge) }
    }

    /// Keep the shed rows, or drop them?
    ///
    /// Two independent reasons to keep them on the web. Only the first survives
    /// the trip to a flipped collection view:
    ///
    ///   · History is on screen, so dropping a shed row opens a hole in it.
    ///     Applies here exactly as it does there.
    ///   · The reader has left the tail, so the shed row's HEIGHT leaves with it
    ///     and everything they are reading slides up by that much. That one is
    ///     the browser's problem: content is anchored from the TOP there, while
    ///     an upside-down collection view measures its offset from the newest
    ///     row, and removing something past the far end moves nothing.
    ///
    /// Ported whole anyway, with both inputs fed for real. Keeping a row this
    /// screen would not have needed costs one row of memory; teaching the two
    /// implementations to answer differently costs the fixture.
    static func shouldKeepShed(historyOnScreen: Bool, followingTail: Bool) -> Bool {
        historyOnScreen || !followingTail
    }

    /// Append shed rows to the history already held.
    ///
    /// Arithmetic only — WHETHER to keep them is `shouldKeepShed`, decided by the
    /// caller, which is the side that knows where the reader is.
    ///
    /// The sort is not stable, unlike JavaScript's. It does not have to be:
    /// `isOlder` is a total order once ids are unique, and two rows sharing an
    /// id cannot both survive the `have` filter above it.
    static func absorb(_ rows: [FoldInput], _ shed: [FoldInput]) -> [FoldInput] {
        guard !shed.isEmpty else { return rows }
        let have = Set(rows.map(\.id))
        let add = shed.filter { !have.contains($0.id) }.sorted(by: isOlder)
        guard !add.isEmpty else { return rows }
        var out = rows + add
        // Shed rows come off the window that sat directly after `rows`, so they
        // are newer than everything held and the concatenation is already
        // ordered. Sort the whole thing only when that is not true — a turn
        // rendered out of sequence is worse than one extra pass.
        if let last = rows.last, let first = add.first, isOlder(first, last) {
            out.sort(by: isOlder)
        }
        return out
    }

    /// How far from the far end of the list a "load earlier" fires.
    ///
    /// `pullMargin` in `apps/dashboard/src/app/chat/page.tsx`: two screens of
    /// runway, floored so a short viewport still gets a useful lead. A function
    /// of the CURRENT height rather than a constant, because the composer grows
    /// and the keyboard opens, and a margin that felt right at 900pt is most of
    /// the screen at 300.
    ///
    /// Hand-copied rather than generated: `WebContract` is rendered from
    /// `const NAME = <number>` declarations, and these two live inside a function
    /// body. Same category as the two numbers `gen-ios-contract.ts` already
    /// reads out of `chat/page.tsx` as text.
    static func pullMargin(viewportHeight: CGFloat) -> CGFloat {
        max(400, viewportHeight * 2)
    }
}
