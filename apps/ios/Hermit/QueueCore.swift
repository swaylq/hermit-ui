import Foundation

/// The waiting-dispatch queue's pure decisions, ported from
/// `apps/dashboard/src/components/chat/queue-core.ts`.
///
/// ## What the queue is
///
/// Messages `chat.send` has written that the gateway has not picked up yet
/// (`deliveredAt: null`, `externalId: null` — the filter lives in
/// `lib/chat-queue.ts` and the server owns it). They run in order once the turn
/// in flight ends. The strip above the composer is the only place they are
/// visible, and pulling one back out is the only chance to un-say something.
///
/// ## Why it is here rather than in the view controller
///
/// Six decisions, four of which are only interesting in the case that goes
/// wrong, and every one is held against the web's own answers by
/// `tools/queue-fixture.sh`. Sibling of `ComposerCore`, which it reuses:
/// retiring an unconfirmed line from this strip is the same `dropLanded` that
/// retires the bubble in the timeline, because it is the same send.
///
/// Foundation only — no UIKit, no SwiftUI.
enum QueueCore {

    /// One line in the strip: a server row, or a send this client has made and
    /// not seen come back. The two are drawn identically on purpose — the
    /// reader has no business knowing which of their messages the server has
    /// acknowledged.
    struct Row: Equatable {
        var id: String
        var content: JSONValue
    }

    // MARK: - Constants the web owns

    /// `QUEUE_LIMIT`. The same number `ComposerCore` prints in its "queue full"
    /// rung; taken from there rather than written again so the two can never
    /// drift apart on a screen where both are visible at once.
    static let limit = ComposerCore.queueLimit

    /// `QUEUE_POLL_MS` — how often the strip asks, while it is asking at all.
    static let pollMs: Double = 2000

    // MARK: - The strings

    /// `{n} 条排队中 · 等当前任务完成后依次执行`.
    static func summary(_ n: Int) -> String {
        "\(n) 条排队中 · 等当前任务完成后依次执行"
    }

    /// The button that empties the strip.
    static let clearLabel = "清空队列"

    /// The one line a queued message shows.
    ///
    /// `preview` is prose the caller has already resolved. On the web that step
    /// puts an auto-translated send back into what was actually typed
    /// (`originalFor`, a browser-only store); here it is plain
    /// `ComposerCore.msgText`. What is decided HERE is only what an EMPTY
    /// preview reads as — empty means the message is attachments and nothing
    /// else, which is a real send and must not draw as a blank line.
    ///
    /// Not a trim: a preview of three spaces is prose as far as this is
    /// concerned, exactly as JavaScript's `||` sees it. `msgText` has already
    /// trimmed by the time this is called, so the case only arises if someone
    /// calls it with something else.
    static func itemLabel(_ preview: String) -> String {
        preview.isEmpty ? "（附件）" : preview
    }

    /// `queueLen >= QUEUE_LIMIT` — the rung `ComposerCore.placeholder` and
    /// `ComposerCore.canSend` read. Counted over what the STRIP shows, which is
    /// what the reader can see and therefore what "full" has to mean to them.
    static func isFull(_ queueLen: Int) -> Bool { queueLen >= limit }

    // MARK: - What the strip shows

    /// Three inputs beyond the server's own list, and each exists because of a
    /// flicker that shipped on the web:
    ///
    ///   · `starters` — a message sent while NOTHING was running is the
    ///     imminent ACTIVE turn, not a queue item, yet it sits in `chat.queue`
    ///     for the ~2s until the gateway picks it up. Without this it flashes
    ///     through the strip on its way to being answered.
    ///   · `cancelled` — a row just pulled, hidden before `dequeue` answers. A
    ///     poll already in the air would otherwise flash it back.
    ///   · `optimistic` — a message sent while a turn IS running is a queue
    ///     item, but its real row only surfaces on the next poll.
    ///
    /// The stubs are retired against the RAW server list, not the filtered one.
    /// A stub whose real row has landed and is being hidden as a starter has
    /// still landed; matching against the filtered list would leave it standing
    /// forever, and the strip would show the same message twice — once as a
    /// stub, once as a row — the moment the starter was delivered.
    static func display(server: [Row],
                        starters: Set<String>,
                        cancelled: Set<String>,
                        optimistic: [ComposerCore.Optimistic]) -> [Row] {
        let real = server.filter { !starters.contains($0.id) && !cancelled.contains($0.id) }
        let landed = server.map { (id: $0.id, content: $0.content) }
        let stubs = ComposerCore.dropLanded(optimistic, landed: landed)
            .map { Row(id: $0.id, content: $0.content) }
        return real + stubs
    }

    /// Both hidden-id sets above, kept bounded.
    ///
    /// An id is KEPT while its row is still in the queue and dropped once the
    /// row has left — which reads backwards for a moment and is the whole
    /// point. A starter that is still undelivered has to stay hidden; an id
    /// whose row is gone can never come back, so remembering it is what would
    /// grow without bound across a long session.
    static func pruneToLive(_ ids: Set<String>, live: [String]) -> Set<String> {
        let alive = Set(live)
        return ids.intersection(alive)
    }

    // MARK: - When to ask again

    /// The poll interval in milliseconds, or nil for "stop asking".
    ///
    /// `queuePollMs` on the web. Named differently here only because the
    /// constant it returns already owns that name in this enum.
    ///
    /// Poll while it MATTERS and not otherwise: the gateway drains the queue as
    /// turns end (so poll while something is in flight) and the reader can pull
    /// a row (so poll while the strip is not empty). Idle and empty, nothing
    /// can change it.
    ///
    /// The count is the SERVER's, not the strip's. A stub with no real row
    /// behind it yet is exactly the state where the next answer matters most,
    /// and counting the strip would make that state stop asking.
    static func pollInterval(inFlight: Bool, serverCount: Int) -> Double? {
        inFlight || serverCount > 0 ? pollMs : nil
    }

    // MARK: - Pulling one back out

    enum CancelTarget: String, Equatable {
        /// A line this client made up: there is no row to delete.
        case local
        /// A real queued row — a `chat.dequeue`, which can answer
        /// `removed: false` when the gateway got there first.
        case server
    }

    /// Where a ✕ on a line goes.
    ///
    /// Decided by membership in the optimistic list, never by the shape of the
    /// id. The web mints `pending-<clock>-<random>` and could sniff the prefix;
    /// this app uses the send's own idempotency key, which looks nothing like
    /// that. Asking the list is the same answer on both sides and rests on no
    /// naming convention — the fixture carries a `pending-`-shaped id that is
    /// NOT in the list, and it is a server row.
    static func cancelTarget(id: String, optimisticIds: [String]) -> CancelTarget {
        optimisticIds.contains(id) ? .local : .server
    }
}
