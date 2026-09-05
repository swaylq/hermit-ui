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
final class ChatTimelineViewController: UIViewController {
    private enum Section { case main }

    private let sessionId: String
    private let title_: String?

    private var collection: UICollectionView!
    private var source: UICollectionViewDiffableDataSource<Section, String>!
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var inFlight: Task<Void, Never>?

    /// The window as merged so far, oldest-first — the fold's input, kept apart
    /// from its output so a push re-folds from the same rows the server sent
    /// rather than from something already grouped into capsules.
    private var inputs: [FoldInput] = []
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
        collection.contentInset = UIEdgeInsets(top: Self.padV, left: 0, bottom: Self.padV, right: 0)
        collection.keyboardDismissMode = .interactive
        // Upside down. The cells are flipped back in the registration below, so
        // each row draws the right way up inside a list that grows downwards
        // from the newest message.
        collection.transform = CGAffineTransform(scaleX: 1, y: -1)
        // With the collection flipped, the indicator would run down the LEFT
        // edge and its inset would be measured from the wrong end.
        collection.showsVerticalScrollIndicator = false
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

        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, String> {
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
            cell.transform = CGAffineTransform(scaleX: 1, y: -1)
        }
        source = UICollectionViewDiffableDataSource(collectionView: collection) { view, indexPath, key in
            view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: key)
        }

        observeAppState()
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
            inputs = TimelineMerge.apply(inputs, frame.rows, gone: frame.gone)
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
                    // Merged, not assigned. On a foreground refresh this screen
                    // may already hold rows older than the window (paged-in
                    // history), and assigning would silently throw them away.
                    self.inputs = TimelineMerge.apply(self.inputs, wire.map(\.asInput))
                    self.inputs = TimelineMerge.fold(self.inputs, self.pending)
                    self.pending = []
                    self.windowLanded = true
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

    /// Re-fold the whole window and redraw whatever changed.
    ///
    /// Folding the lot on every frame is the blunt option and it is the right
    /// one here: `FoldRuns.safeSplitIndex` exists precisely because folding a
    /// suffix is not guaranteed to equal folding the whole, and a live tail is
    /// exactly where a seam would land. Sixty rows of pure-function work per
    /// push is not the cost worth being clever about.
    private func refold() {
        show(rows: FoldRuns.fold(inputs))
        message.isHidden = !inputs.isEmpty
        if inputs.isEmpty { message.text = "Nothing in this conversation yet." }
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
        var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
        snapshot.appendSections([.main])
        snapshot.appendItems(order, toSection: .main)
        if !changed.isEmpty { snapshot.reconfigureItems(changed) }
        source.apply(snapshot, animatingDifferences: false)
    }
}
