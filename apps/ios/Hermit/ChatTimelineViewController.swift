import UIKit
import SwiftUI

/// The chat timeline, drawn natively. The skeleton of M4.
///
/// ## Not the front door yet
///
/// Reached only through `hermit://timeline/<session id>`, exactly the way the
/// native session list was introduced: a new screen goes up on a URL first, so
/// it can be walked through and screenshotted without becoming the thing every
/// tap lands on. Tapping a row in the list still opens the web chat page, and
/// will until this screen has the composer (M5) — a timeline you cannot reply
/// in is not a replacement for one you can.
///
/// ## Upside down
///
/// The collection view is flipped vertically and so is every cell, which is the
/// standard messaging-list trick and it buys two things that are otherwise
/// genuinely hard:
///
///   · "Stuck to the newest message" is just contentOffset zero. No sticky
///     bottom observer, no scroll-to-end after layout, and nothing to fight
///     when the keyboard changes the visible height.
///   · Loading older history becomes an APPEND. Inserting at the top of a
///     normal list moves everything below it, so the reader's position has to
///     be restored by hand against a content size that has not settled — the
///     web spends `use-prepend-anchor.ts` (514 lines) on exactly that. Appended
///     below the fold, it costs nothing and there is nothing to restore.
///
/// The price is that `row 0` is the NEWEST row, which is why `rows` is stored
/// reversed and why anything reading it says so.
///
/// ## One query, then a live tail
///
/// `chat.listMessages` for the newest window, `WebContract.timelineLimit` rows
/// with `WebContract.timelineDigest` — the same window the web asks for, from
/// the generated contract rather than from two numbers typed here. A
/// `HermitStream` opens alongside it with `skipInitial`, so the window is paid
/// for once, and every later change arrives as a delta.
///
/// The two racing is the whole subtlety, and `TimelineMerge.fold` is the answer:
/// a push that lands before the query answers is HELD, not applied, because a
/// delta applied to an empty list looks exactly like a complete window.
///
/// ## Two lists, and the seam between them
///
/// The live window above is a fixed `WebContract.timelineLimit` rows that slides
/// forward; history is paged in separately, `WebContract.olderPage` rows at a
/// time, and the screen draws the concatenation. Nothing checks that the two
/// meet — and they stop meeting on their own, because every row the window sheds
/// off its old end belongs to neither list afterwards. The web measured what
/// that costs: 162 messages and fifteen minutes closed over silently, with the
/// compaction notice the reader was looking for inside the gap. `TimelinePager`
/// is the half that keeps them meeting.
/// A list cell that stays flipped.
///
/// The collection view below is upside down and every cell is flipped back, so
/// each row reads the right way up inside a list that grows downwards from the
/// newest message. The flip has to be re-applied HERE and not only where the
/// cell is configured: `UICollectionViewLayoutAttributes` carries a transform of
/// its own — identity — and `apply(_:)` assigns it over whatever the cell was
/// holding. A transform set at dequeue time therefore survives exactly until the
/// next layout pass and then silently goes away.
///
/// The symptom is the entire conversation drawn mirrored top to bottom, with
/// the navigation bar the right way up above it. Nothing on the Mac can show it:
/// `tools/render-timeline.sh` draws the rows in a plain `VStack` and there is no
/// collection view anywhere in that path, so this shipped in round 20 and was
/// found the first time the screen ran on a phone.
private final class FlippedListCell: UICollectionViewListCell {
    static let flip = CGAffineTransform(scaleX: 1, y: -1)

    override func apply(_ layoutAttributes: UICollectionViewLayoutAttributes) {
        super.apply(layoutAttributes)
        transform = Self.flip
    }
}

final class ChatTimelineViewController: UIViewController {
    private enum Section { case main }

    private let sessionId: String
    private let title_: String?

    private var collection: UICollectionView!
    private var source: UICollectionViewDiffableDataSource<Section, String>!
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var inFlight: Task<Void, Never>?

    /// The LIVE window, oldest-first — the newest `WebContract.timelineLimit`
    /// rows, and the only rows the stream carries. Kept apart from the fold's
    /// output so a push re-folds from the same rows the server sent rather than
    /// from something already grouped into capsules.
    private var window: [FoldInput] = []
    /// History paged in below the window, oldest-first. Grows upwards, one
    /// `chat.listMessagesBefore` page at a time, and absorbs whatever the window
    /// sheds while it is on screen.
    private var older: [FoldInput] = []
    /// Window + history, which is the conversation the fold is run over.
    private var allInputs: [FoldInput] { older + window }
    private var stream: HermitStream<WireMessage>?
    private var streamTask: Task<Void, Never>?
    /// Frames that arrived before `chat.listMessages` answered. See
    /// `TimelineMerge.fold`.
    private var pending: [TimelineMerge.Frame] = []
    private var windowLanded = false

    /// Newest first — see the class comment. Keyed lookups go through `rowsByKey`
    /// because the diffable data source carries `FoldedRow.key`, not the row.
    private var order: [String] = []
    private var rowsByKey: [String: FoldedRow] = [:]

    // MARK: Paging state
    //
    // `hasMore` is two facts, exactly as the web splits them: a SEED (the window
    // came back full, so there is probably history behind it) and an ANSWER (a
    // server page said so). Only a server page may set the answer — routing it
    // into a field nobody reads is what once left the web's button pulling
    // forever at the beginning of a session.

    /// Set only by a server page. Nil until one has been served.
    private var saysMore: Bool?
    /// The seed: `chat.listMessages` came back at its limit.
    private var windowFull = false
    private var hasMore: Bool { saysMore ?? windowFull }
    private var loadingOlder = false
    private var olderTask: Task<Void, Never>?
    /// The `loading` the pill cell was last configured with, or nil when there
    /// is no pill. Diffable will not redraw a cell whose identifier is unchanged.
    private var pillShows: Bool?

    /// The one identifier in the snapshot that is not a `FoldedRow.key`. Starts
    /// with a NUL, which no key the fold produces can contain.
    private static let earlierKey = "\u{0000}load-earlier"

    /// Within this much of the newest row, the reader is following the tail.
    /// `BOTTOM_SLACK` in `components/chat/use-prepend-anchor.ts`, which answers
    /// the same question there. Hand-copied: `WebContract` is rendered from
    /// `const NAME = <number>` declarations and this one means points here, CSS
    /// pixels there.
    private static let tailSlack: CGFloat = 60

    /// `px-4 py-4` on the web's scroller. The column it wraps is `max-w-3xl`
    /// centred, which on a phone never binds.
    private static let padH: CGFloat = 16
    private static let padV: CGFloat = 16

    init(sessionId: String, title: String? = nil) {
        self.sessionId = sessionId
        self.title_ = title
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        title = title_ ?? "Chat"
        view.backgroundColor = UIColor { traits in
            UIColor(WebContract.background.resolve(traits.userInterfaceStyle == .dark ? .dark : .light))
        }

        var config = UICollectionLayoutListConfiguration(appearance: .plain)
        config.showsSeparators = false
        config.backgroundColor = .clear
        collection = UICollectionView(
            frame: .zero,
            collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config)
        )
        collection.backgroundColor = .clear
        collection.translatesAutoresizingMaskIntoConstraints = false
        // `contentInset` is set in `applyInsets`, which has to know the safe
        // area first.
        collection.keyboardDismissMode = .interactive
        // Upside down. The cells are flipped back in the registration below, so
        // each row draws the right way up inside a list that grows downwards
        // from the newest message.
        collection.transform = CGAffineTransform(scaleX: 1, y: -1)
        // With the collection flipped, the indicator would run down the LEFT
        // edge and its inset would be measured from the wrong end.
        collection.showsVerticalScrollIndicator = false
        // iOS 26 blurs and lightens scroll content near a scroll view's edges,
        // fading the effect out with distance so a translucent navigation bar
        // has something legible behind it. The flip turns the mask inside out:
        // full strength across the whole visible conversation, and NOTHING in
        // the strip actually behind the bar. On a phone the timeline came out
        // soft and washed to about 15% contrast — every message still there,
        // every assertion still passing, and unreadable. Only reading the pixels
        // out of a screenshot says so; on the Mac `render-timeline.sh` never
        // touches a scroll view and cannot show it at all.
        //
        // Turned off rather than restyled. The web draws no such effect, and
        // "the same as the web" is the standard this screen is held to.
        if #available(iOS 26.0, *) {
            collection.topEdgeEffect.isHidden = true
            collection.bottomEdgeEffect.isHidden = true
        }
        collection.delegate = self
        view.addSubview(collection)

        message.numberOfLines = 0
        message.textAlignment = .natural
        message.font = .systemFont(ofSize: 12)
        message.textColor = UIColor { traits in
            UIColor(WebContract.mutedForeground.resolve(traits.userInterfaceStyle == .dark ? .dark : .light))
        }
        message.translatesAutoresizingMaskIntoConstraints = false
        message.isHidden = true
        view.addSubview(message)

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)

        NSLayoutConstraint.activate([
            collection.topAnchor.constraint(equalTo: view.topAnchor),
            collection.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            collection.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collection.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            message.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Self.padH),
            message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Self.padH),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])

        let cell = UICollectionView.CellRegistration<FlippedListCell, String> {
            [weak self] cell, _, key in
            guard let self, let row = self.rowsByKey[key] else { return }
            let width = self.contentWidth
            cell.contentConfiguration = UIHostingConfiguration {
                TimelineRowView(row: row, width: width)
                    // `gap-3` between rows, split across the two rows that share
                    // each gap. Half on each side survives the flip — a whole
                    // gap on one edge would land above the newest row in a
                    // list that is upside down, which is not where the web puts
                    // it.
                    .padding(.vertical, TimelineMetrics.rowGap / 2)
            }
            .margins(.horizontal, Self.padH)
            .margins(.vertical, 0)
            var background = UIBackgroundConfiguration.clear()
            background.backgroundColor = .clear
            cell.backgroundConfiguration = background
            // Undo the collection's flip so the row itself reads normally.
            // Belt and braces with `FlippedListCell.apply`: this covers the
            // frames before the layout has applied any attributes.
            cell.transform = FlippedListCell.flip
        }
        let earlier = UICollectionView.CellRegistration<FlippedListCell, String> {
            [weak self] cell, _, _ in
            guard let self else { return }
            let loading = self.loadingOlder
            cell.contentConfiguration = UIHostingConfiguration {
                LoadEarlierPill(loading: loading) { [weak self] in self?.loadEarlier() }
                    // `pb-3`, less the half-gap every row cell already carries on
                    // the side facing this one.
                    .padding(.bottom, TimelineMetrics.earlierGap - TimelineMetrics.rowGap / 2)
            }
            .margins(.horizontal, Self.padH)
            .margins(.vertical, 0)
            var background = UIBackgroundConfiguration.clear()
            background.backgroundColor = .clear
            cell.backgroundConfiguration = background
            cell.transform = FlippedListCell.flip
        }
        source = UICollectionViewDiffableDataSource(collectionView: collection) { view, indexPath, key in
            key == Self.earlierKey
                ? view.dequeueConfiguredReusableCell(using: earlier, for: indexPath, item: key)
                : view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: key)
        }

        observeAppState()
        applyInsets()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        applyInsets()
    }

    /// Put the safe area on the ends of the list a reader actually sees it on.
    ///
    /// The collection is flipped, so its content-space TOP is the BOTTOM of the
    /// screen — and UIKit's own safe-area adjustment does not know that. Left
    /// alone it adds the navigation bar's inset at content-top, which lands as a
    /// hundred points of dead space under the newest message, while the oldest
    /// rows scroll under the status bar with `padV` and nothing else. That is
    /// what the first simulator run of this screen looked like.
    ///
    /// Fixed by cancelling out what UIKit contributes rather than by turning the
    /// adjustment off: `adjustedContentInset = safeAreaInsets + contentInset`, so
    /// asking for the two ends swapped is arithmetic. The alternative —
    /// `contentInsetAdjustmentBehavior = .never` — also means owning the resting
    /// content offset by hand, and writing `contentOffset` from inside a layout
    /// pass is exactly the re-entrancy that killed `scrollViewDidScroll`.
    ///
    /// A negative component is fine and expected: on a phone the status bar plus
    /// the navigation bar is taller than the home indicator, so `top` here is
    /// normally below zero.
    private func applyInsets() {
        let safe = view.safeAreaInsets
        let wanted = UIEdgeInsets(top: safe.bottom + Self.padV - safe.top, left: 0,
                                  bottom: safe.top + Self.padV - safe.bottom, right: 0)
        guard collection.contentInset != wanted else { return }
        collection.contentInset = wanted
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
        start()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(true, animated: animated)
        }
        teardown()
    }

    /// Backgrounding tears the stream down and foregrounding builds a new one.
    ///
    /// Not a nicety: iOS suspends the process, the socket dies without anyone
    /// being told, and the zombie watchdog only fires once code is running again
    /// — so a resumed screen would sit on a dead connection for up to
    /// `streamIdleDeadline` looking perfectly connected. Coming back re-runs the
    /// window query too, which is what closes the gap the suspension left.
    private func observeAppState() {
        let c = NotificationCenter.default
        c.addObserver(self, selector: #selector(appDidBackground),
                      name: UIApplication.didEnterBackgroundNotification, object: nil)
        c.addObserver(self, selector: #selector(appWillForeground),
                      name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func appDidBackground() { teardown() }

    @objc private func appWillForeground() {
        guard view.window != nil else { return }
        start()
    }

    /// What a row has to lay out in: the collection's width less the cell's own
    /// horizontal margins. `max-w-[85%]` is a fraction of THIS, and the row
    /// cannot ask for it — see the note on `TimelineRowView.width`.
    private var contentWidth: CGFloat {
        max(0, collection.bounds.width - Self.padH * 2)
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        // Every bubble is capped at a fraction of a width that just changed, and
        // the cells hold the old number. Rotating without this leaves the whole
        // conversation at the portrait width.
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let self, !self.order.isEmpty else { return }
            var snapshot = self.source.snapshot()
            snapshot.reconfigureItems(snapshot.itemIdentifiers)
            self.source.apply(snapshot, animatingDifferences: false)
        }
    }

    // MARK: - Loading

    /// One wire row of `chat.listMessages`, and of every `messages` frame on the
    /// stream. Deliberately one type for both: the server sends the same narrow
    /// select down each, and the merge is by id ACROSS the two, so a second
    /// shape here would be two ways to spell the same row.
    ///
    /// `content` stays JSON: the fold reads the raw blocks (`FoldRuns` classifies
    /// on the producer's own type string — see the note in `FoldRuns.swift` on
    /// why it must), and `ContentBlock` parses them a second time for the
    /// renderer.
    struct WireMessage: Decodable {
        let id: String
        let role: String
        let content: JSONValue
        let createdAt: String
        let authoredBy: String?

        var asInput: FoldInput {
            FoldInput(id: id, role: role, content: content,
                      createdAt: createdAt, authoredBy: authoredBy)
        }
    }

    private struct WindowInput: Encodable {
        let sessionId: String
        let limit: Int
        let digest: Bool
    }

    /// Open the stream and fetch the window, in that order.
    ///
    /// The stream goes first on purpose. It cannot miss anything by starting
    /// early — frames before the window are held — but starting it second means
    /// every change between the query being answered and the socket being open
    /// is simply lost, and nothing later notices, because both halves look
    /// healthy afterwards.
    private func start() {
        guard let entry = KeyStore.active() else {
            teardown()
            show(rows: [])
            message.text = "No machine key on this device yet.\n"
                + "Sign in on the web view first — the timeline reads the same keyring."
            message.isHidden = false
            return
        }
        teardown()
        message.isHidden = true
        if order.isEmpty { spinner.startAnimating() }
        let base = KeyStore.base(for: entry)
        openStream(origin: base)
        loadWindow(origin: base)
    }

    private func teardown() {
        inFlight?.cancel()
        inFlight = nil
        olderTask?.cancel()
        olderTask = nil
        loadingOlder = false
        streamTask?.cancel()
        streamTask = nil
        stream?.stop()
        stream = nil
        pending = []
        windowLanded = false
    }

    private func openStream(origin: URL) {
        let s = HermitStream<WireMessage>(
            origin: origin,
            sessionId: sessionId,
            key: { KeyStore.active()?.key ?? "" },
            // The window query below is already paying for this window.
            skipInitial: true
        )
        stream = s
        streamTask = Task { [weak self] in
            for await event in s.events {
                if Task.isCancelled { return }
                await MainActor.run { self?.handle(event) }
            }
        }
        s.start()
    }

    @MainActor
    private func handle(_ event: HermitStream<WireMessage>.Event) {
        switch event {
        case .messages(let rows, let gone):
            let frame = TimelineMerge.Frame(rows: rows.map(\.asInput), gone: gone)
            guard windowLanded else {
                pending.append(frame)
                return
            }
            adopt(window: TimelineMerge.apply(window, frame.rows, gone: frame.gone))
            refold()
        case .status, .connected, .frameDropped:
            // Status drives the header (not built yet); a dropped frame is one
            // unreadable payload on a connection that is still good, and the
            // next frame carries the row again.
            break
        case .disconnected:
            // Silent on purpose: the stream reconnects itself, and a banner that
            // flashes on every backoff is worse than the gap it announces. The
            // screen keeps showing what it has.
            break
        }
    }

    private func loadWindow(origin: URL) {
        let api = HermitAPI(origin: origin, key: { KeyStore.active()?.key ?? "" })
        let input = WindowInput(sessionId: sessionId,
                                limit: WebContract.timelineLimit,
                                digest: WebContract.timelineDigest)
        inFlight = Task { [weak self] in
            do {
                let wire = try await api.query("chat.listMessages", input: input, as: [WireMessage].self)
                if Task.isCancelled { return }
                await MainActor.run {
                    guard let self else { return }
                    self.inFlight = nil
                    self.spinner.stopAnimating()
                    // The query's rows ARE the window — it is the newest N and
                    // nothing else. Merging into what the screen already held
                    // would let the window grow without bound across foreground
                    // refreshes, and would hide the shed rows from `adopt`,
                    // which is the one place that can still save them.
                    self.adopt(window: TimelineMerge.fold(wire.map(\.asInput), self.pending))
                    self.pending = []
                    self.windowLanded = true
                    // The seed for "is there history behind this?": a window
                    // that came back at its limit probably has some. Only a
                    // server page may overrule it — see `saysMore`.
                    self.windowFull = wire.count >= WebContract.timelineLimit
                    self.refold()
                }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run {
                    guard let self else { return }
                    self.inFlight = nil
                    self.spinner.stopAnimating()
                    guard self.order.isEmpty else { return }
                    // The web's own sentence, plus the reason — every way this
                    // fails looks like an empty conversation otherwise.
                    self.message.text = "Couldn't load this conversation.\n\(error.localizedDescription)"
                    self.message.isHidden = false
                }
            }
        }
    }

    /// Move the live window forward, keeping whatever it shed.
    ///
    /// The rows that leave the window — slid off by newer ones, or named in the
    /// stream's `gone` — are handed to the history list rather than dropped,
    /// whenever losing them would be visible. `TimelinePager.shouldKeepShed`
    /// decides; this method is the only place `window` is assigned, so there is
    /// no path that can skip it.
    @MainActor
    private func adopt(window next: [FoldInput]) {
        let shed = TimelinePager.shed(window, next)
        if !shed.isEmpty,
           TimelinePager.shouldKeepShed(historyOnScreen: !older.isEmpty,
                                        followingTail: isFollowingTail) {
            older = TimelinePager.absorb(older, shed)
        }
        window = next
    }

    /// Is the reader parked on the newest row?
    ///
    /// The list is upside down, so "at the tail" is contentOffset zero — plus
    /// the inset the collection adds, which is not zero at rest.
    private var isFollowingTail: Bool {
        collection.contentOffset.y + collection.adjustedContentInset.top <= Self.tailSlack
    }

    private struct PageInput: Encodable {
        let sessionId: String
        let beforeId: String
        let limit: Int
        let digest: Bool
    }

    private struct OlderPage: Decodable {
        let rows: [WireMessage]
        let hasMore: Bool
    }

    /// One page of history older than the oldest row on screen.
    ///
    /// Server only, for now: the web serves a page straight out of IndexedDB
    /// when the store can PROVE it holds one unbroken run reaching the anchor
    /// (`pageBefore`, walking the `nextId` each row was written with). `ChatCache`
    /// here has the prose layer but not the row layer that proof reads, so this
    /// screen always asks. Adding the store is what makes the proof portable;
    /// porting the proof first would be a function with nothing to check.
    ///
    /// Appending rather than prepending, because the list is flipped. This is
    /// the trade the flip was taken for: the web spends `use-prepend-anchor.ts`
    /// (514 lines) holding the reader's position while history lands above them,
    /// and here the same page lands below the fold and moves nothing.
    private func loadEarlier() {
        guard !loadingOlder, hasMore, let entry = KeyStore.active() else { return }
        // The oldest row held, whichever list it is in. Nil only before the
        // first window lands, which `hasMore` has already ruled out.
        guard let anchor = older.first ?? window.first else { return }
        loadingOlder = true
        refold()

        let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
        // Digested, like the web's pager: the collapsed timeline shows tool names
        // and first lines, and about two thirds of an undigested page is
        // tool_result nobody paints. Opening a capsule fetches the real bodies.
        let input = PageInput(sessionId: sessionId, beforeId: anchor.id,
                              limit: WebContract.olderPage, digest: true)
        olderTask = Task { [weak self] in
            let page = try? await api.query("chat.listMessagesBefore", input: input, as: OlderPage.self)
            if Task.isCancelled { return }
            await MainActor.run {
                guard let self else { return }
                self.olderTask = nil
                self.loadingOlder = false
                guard let page else {
                    // Leave `saysMore` alone: a failed request says nothing about
                    // whether history exists, and writing `false` here would
                    // retire the pill over one dropped connection.
                    self.refold()
                    return
                }
                // A page that came back empty is the beginning of the session,
                // whatever the flag claims. Trusting the flag alone is how a
                // button ends up pulling forever: it stays offered, every scroll
                // at the far end fires another pull, each returns nothing.
                self.saysMore = page.hasMore && !page.rows.isEmpty
                if !page.rows.isEmpty { self.older = page.rows.map(\.asInput) + self.older }
                self.refold()
            }
        }
    }

    /// Re-fold the whole window and redraw whatever changed.
    ///
    /// Folding the lot on every frame is the blunt option and it is the right
    /// one here: `FoldRuns.safeSplitIndex` exists precisely because folding a
    /// suffix is not guaranteed to equal folding the whole, and a live tail is
    /// exactly where a seam would land. Sixty rows of pure-function work per
    /// push is not the cost worth being clever about.
    private func refold() {
        let all = allInputs
        show(rows: FoldRuns.fold(all))
        message.isHidden = !all.isEmpty
        if all.isEmpty { message.text = "Nothing in this conversation yet." }
    }

    /// `rows` arrives oldest-first, the way the fold produces it and the way the
    /// web renders it. It is reversed here, once, because the list is upside
    /// down; everything downstream of this line is newest-first.
    private func show(rows: [FoldedRow]) {
        let newestFirst = Array(rows.reversed())
        // A row whose key survives but whose CONTENT changed — the open run
        // gaining a step, a reply growing a sentence — is the common case while
        // a turn streams, and diffable will not redraw it on identifier alone.
        // The session list learned this the same way in round 14.
        let changed: [String] = newestFirst.compactMap { row in
            guard let old = rowsByKey[row.key], old != row else { return nil }
            return row.key
        }
        order = newestFirst.map(\.key)
        rowsByKey = Dictionary(newestFirst.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
        // LAST, because the list is upside down: the item after the oldest row
        // is the one drawn above it.
        let showPill = hasMore && !newestFirst.isEmpty
        var items = order
        if showPill { items.append(Self.earlierKey) }
        var reconfigure = changed
        // Same problem as a row whose content changed under an unchanged key:
        // `loading…` and `↑ load earlier` are one identifier.
        if showPill, pillShows != loadingOlder { reconfigure.append(Self.earlierKey) }
        pillShows = showPill ? loadingOlder : nil
        var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
        snapshot.appendSections([.main])
        snapshot.appendItems(items, toSection: .main)
        if !reconfigure.isEmpty { snapshot.reconfigureItems(reconfigure) }
        source.apply(snapshot, animatingDifferences: false)
    }
}

// MARK: - Pulling history in

extension ChatTimelineViewController: UICollectionViewDelegate {
    /// Infinite scroll-up, which on a flipped list is scrolling towards the END.
    ///
    /// `pullMargin` in `chat/page.tsx`: fire while there is less than two
    /// screens of runway left, floored so a short viewport still gets a useful
    /// lead. `loadEarlier` is the one that decides whether a pull is legal, so a
    /// fling that crosses the line on twenty consecutive frames still costs one
    /// request.
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView.bounds.height > 0 else { return }
        let runway = scrollView.contentSize.height - (scrollView.contentOffset.y + scrollView.bounds.height)
        guard runway < TimelinePager.pullMargin(viewportHeight: scrollView.bounds.height) else { return }
        // NOT synchronously. This runs inside the collection view's own layout
        // pass, and `loadEarlier` applies a snapshot immediately — the pill
        // turning into `loading…`. Mutating a collection view from inside its
        // layout re-enters `_updateVisibleCellsNow`, and with self-sizing cells
        // the nesting does not settle: UIKit trips an assertion several levels
        // down and the app is gone. It killed a run on the first pull and let
        // the next one through, which is what a re-entrancy bug looks like from
        // the outside.
        //
        // Coalescing is `loadEarlier`'s own guard: several blocks may be queued
        // before the first runs, and the first sets `loadingOlder` before
        // returning, so the rest are no-ops.
        DispatchQueue.main.async { [weak self] in self?.loadEarlier() }
    }
}
