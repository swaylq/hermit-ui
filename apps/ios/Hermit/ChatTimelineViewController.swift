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
/// ## One query, no stream
///
/// `chat.listMessages` for the newest window, `WebContract.timelineLimit` rows
/// with `WebContract.timelineDigest` — the same window the web asks for, from
/// the generated contract rather than from two numbers typed here. There is no
/// SSE yet: `HermitStream` exists and works, but wiring a live tail into a
/// screen whose rows have never been looked at would mean debugging two new
/// things at once.
final class ChatTimelineViewController: UIViewController {
    private enum Section { case main }

    private let sessionId: String
    private let title_: String?

    private var collection: UICollectionView!
    private var source: UICollectionViewDiffableDataSource<Section, String>!
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var inFlight: Task<Void, Never>?

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
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
        load()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(true, animated: animated)
        }
        inFlight?.cancel()
        inFlight = nil
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

    /// One wire row of `chat.listMessages`. `content` stays JSON: the fold reads
    /// the raw blocks (`FoldRuns` classifies on the producer's own type string —
    /// see the note in `FoldRuns.swift` on why it must), and `ContentBlock`
    /// parses them a second time for the renderer.
    private struct WireMessage: Decodable {
        let id: String
        let role: String
        let content: JSONValue
        let createdAt: String
        let authoredBy: String?
    }

    private struct WindowInput: Encodable {
        let sessionId: String
        let limit: Int
        let digest: Bool
    }

    private func load() {
        guard let entry = KeyStore.active() else {
            show(rows: [])
            message.text = "No machine key on this device yet.\n"
                + "Sign in on the web view first — the timeline reads the same keyring."
            message.isHidden = false
            return
        }
        inFlight?.cancel()
        message.isHidden = true
        if order.isEmpty { spinner.startAnimating() }
        let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
        let input = WindowInput(sessionId: sessionId,
                                limit: WebContract.timelineLimit,
                                digest: WebContract.timelineDigest)
        inFlight = Task { [weak self] in
            do {
                let wire = try await api.query("chat.listMessages", input: input, as: [WireMessage].self)
                if Task.isCancelled { return }
                let rows = FoldRuns.fold(wire.map {
                    FoldInput(id: $0.id, role: $0.role, content: $0.content,
                              createdAt: $0.createdAt, authoredBy: $0.authoredBy)
                })
                await MainActor.run {
                    guard let self else { return }
                    self.inFlight = nil
                    self.spinner.stopAnimating()
                    self.show(rows: rows)
                    self.message.isHidden = !rows.isEmpty
                    if rows.isEmpty { self.message.text = "Nothing in this conversation yet." }
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

    /// `rows` arrives oldest-first, the way the fold produces it and the way the
    /// web renders it. It is reversed here, once, because the list is upside
    /// down; everything downstream of this line is newest-first.
    private func show(rows: [FoldedRow]) {
        let newestFirst = rows.reversed()
        order = newestFirst.map(\.key)
        rowsByKey = Dictionary(newestFirst.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
        var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
        snapshot.appendSections([.main])
        snapshot.appendItems(order, toSection: .main)
        source.apply(snapshot, animatingDifferences: false)
    }
}
