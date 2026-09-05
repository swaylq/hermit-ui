import Foundation

/// Applying a chat-stream push to the window a screen already holds.
///
/// Port of `apps/dashboard/src/lib/chat-cache/merge-messages.ts`, kept
/// deliberately close to it: the two run against the same fixture table
/// (`tools/fixtures/merge-cases.json`), so any place they disagree is a test
/// failure rather than a difference someone notices on a phone months later.
///
/// ## What is NOT ported
///
/// The web's `rowSig` / reference-stability half. It exists so a re-sent row
/// keeps its JavaScript object identity and `memo(MessageRow)` can bail out of
/// re-parsing markdown several times a second. Swift has no such problem here:
/// rows are values, and the redraw decision is made one layer up by comparing
/// `FoldedRow` values and reconfiguring only the keys that actually changed.
/// Porting the machinery would have carried the cost and none of the benefit.
enum TimelineMerge {
    /// One frame off the stream: the rows it changed, and the ids that left the
    /// window.
    struct Frame: Equatable {
        var rows: [FoldInput]
        var gone: [String]

        init(rows: [FoldInput], gone: [String] = []) {
            self.rows = rows
            self.gone = gone
        }
    }

    /// Same order the server sends: ascending by `createdAt`, id breaking ties.
    ///
    /// The instants are parsed rather than the strings compared, and that is not
    /// pedantry — the server sends both shapes. `…:00Z` and `…:00.500Z` are half
    /// a second apart, but byte-wise the fractional one sorts FIRST, because
    /// `.` (0x2E) is below `Z` (0x5A). Sorting the strings puts a message before
    /// one that happened before it, roughly whenever a turn straddles a whole
    /// second.
    static func before(_ a: FoldInput, _ b: FoldInput) -> Bool {
        let ta = HermitAPI.isoDate(a.createdAt) ?? .distantPast
        let tb = HermitAPI.isoDate(b.createdAt) ?? .distantPast
        if ta != tb { return ta < tb }
        return a.id < b.id
    }

    /// Merge a push into the held window.
    ///
    /// `next` is whatever the push carried: a delta, or a whole window — the
    /// same code serves both, because a whole window is a delta that happens to
    /// mention every row.
    ///
    /// `gone` is how a row LEAVES: an id the stream has sent and can no longer
    /// see, which covers both "scrolled out of the window by newer rows" and
    /// "actually deleted". Without it a delta-fed list could only ever grow.
    static func apply(_ prev: [FoldInput], _ next: [FoldInput], gone: [String] = []) -> [FoldInput] {
        if prev.isEmpty {
            // Deliberately NOT sorted, matching the web: a push into an empty
            // window is the server's own ordering and re-sorting it here would
            // be this port inventing an order the other side does not have.
            guard !gone.isEmpty else { return next }
            let drop = Set(gone)
            return next.filter { !drop.contains($0.id) }
        }
        var byId = Dictionary(prev.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for n in next { byId[n.id] = n }
        for id in gone { byId.removeValue(forKey: id) }
        return byId.values.sorted(by: before)
    }

    /// Fold pushes that arrived BEFORE the window they belong to.
    ///
    /// The first connect asks the server to skip its opening full-window emit,
    /// because `chat.listMessages` is already in flight for the same window.
    /// That leaves a gap of one round trip in which a push can land on a screen
    /// holding nothing — and a delta applied to nothing IS the whole window as
    /// far as everything downstream can tell. The web measured what that looks
    /// like: on a session mid-turn, 13 rows became the 1 row the push carried.
    ///
    /// So frames in the gap are held, not applied, and folded onto the window
    /// the moment it lands. A later frame's version of a row wins; an id
    /// reported gone stays gone.
    static func fold(_ base: [FoldInput], _ frames: [Frame]) -> [FoldInput] {
        frames.reduce(base) { apply($0, $1.rows, gone: $1.gone) }
    }
}
