import Foundation

/// The last session list a machine answered with, kept on disk so the list
/// paints rows instead of a skeleton the moment it is opened.
///
/// A port of `apps/dashboard/src/lib/session-list-cache.ts`, including the three
/// parts of it that look like details and are not:
///
/// - **One file per keyring entry.** The rows belong to one machine and must
///   never appear under another, so the file name is the entry id. Switching
///   machines reads a different file rather than a stale one — the same reason
///   `lib/last-session.ts` and `lib/chat-filter.ts` are per machine on the web.
/// - **A placeholder, never a source of truth.** It seeds the first frame and
///   the fetch already in flight replaces it, so stale rows live for exactly one
///   round trip. Tapping a session deleted since is already handled: the chat
///   page re-lands when an id does not resolve.
/// - **Throttled writes.** `chat.listSessions` is answered every five seconds
///   and its runtime fields move on every one of them, so the rows differ far
///   more often than the screen does. Writing ~90 KB of JSON per poll is real
///   work for no benefit; a snapshot a few seconds behind costs nothing, since
///   it is only ever the frame before the fetch lands.
///
/// Where the web says `localStorage`, this says one JSON file in Application
/// Support — **not** a table in `ChatCache`, which is the other obvious home.
/// That database is scoped by WORKSPACE (a machine id, plus the agent name for a
/// share key) while this is keyed by keyring ENTRY, and opening it runs a
/// migration plus a `CREATE VIRTUAL TABLE … USING fts5`. This path runs before
/// this screen's first frame, and on a phone old enough for that CREATE to fail
/// it would take the screen down with it. Reading a small file is the whole job.
enum SessionListCache {
    /// The web's `MIN_WRITE_MS`, in seconds.
    static let minWriteInterval: TimeInterval = 20

    /// Encoding and writing happen here, off the main thread, because the caller
    /// is a poll handler on it. Serial, so two polls landing together cannot
    /// interleave into one file, and it is also what guards `lastWriteAt`.
    private static let queue = DispatchQueue(label: "ai.swaylab.hermit.session-list-cache")

    /// Guarded by `queue`.
    private static var lastWriteAt: Date?

    /// The active machine's last known list, or nil when there isn't a usable one.
    ///
    /// An empty stored list reads as nil, exactly as the web's does: "no rows" is
    /// what the skeleton and then the empty-state sentence are for, and seeding
    /// the screen with `[]` would replace both with a blank.
    ///
    /// Every failure — no file yet, a half-written one, a shape this build no
    /// longer decodes — is the same answer, because the caller can do nothing
    /// different with any of them and the real fetch is already out.
    static func read(entryId: String?) -> [SessionListItem]? {
        guard let entryId, !entryId.isEmpty else { return nil }
        do {
            let data = try Data(contentsOf: try file(for: entryId))
            let rows = try HermitAPI.decoder.decode([SessionListItem].self, from: data)
            return rows.isEmpty ? nil : rows
        } catch {
            return nil
        }
    }

    /// Keep this answer for the next cold start. Only ever called with a list the
    /// server actually returned — an empty one included, so a machine whose last
    /// session was deleted stops painting it.
    static func write(_ rows: [SessionListItem], entryId: String?) {
        guard let entryId, !entryId.isEmpty else { return }
        queue.async {
            let now = Date()
            if let last = lastWriteAt, now.timeIntervalSince(last) < minWriteInterval { return }
            do {
                let data = try HermitAPI.encoder.encode(rows)
                // Atomic: a snapshot half on disk when the app is killed would be
                // read back as a decode failure on every launch afterwards.
                try data.write(to: try file(for: entryId), options: .atomic)
                lastWriteAt = now
            } catch {
                // Out of space, or a container we cannot write. Nothing to do
                // and nothing to show: the only cost is a skeleton next launch.
                NSLog("[hermit] could not keep a session-list snapshot: \(error)")
            }
        }
    }

    /// Forget one machine's snapshot. Signing out of a machine is the case: its
    /// rows must not paint on the next launch just because the file outlived the
    /// key that could have refreshed it.
    static func forget(entryId: String?) {
        guard let entryId, !entryId.isEmpty else { return }
        queue.async {
            if let url = try? file(for: entryId) { try? FileManager.default.removeItem(at: url) }
        }
    }

    static func file(for entryId: String) throws -> URL {
        // ChatCache's escaping rather than a second one. An entry id is whatever
        // the server minted, and two stores that disagreed about what is safe in
        // a file name would disagree about which machine a file belongs to.
        try directory().appendingPathComponent(ChatCache.fileSafe(entryId) + ".json")
    }

    /// Application Support, not Caches: an evicted snapshot is a skeleton on the
    /// one launch that wanted it most. Excluded from backup — it is a copy of
    /// something the server can re-send in one request.
    static func directory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var dir = base.appendingPathComponent("SessionLists", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }
}
