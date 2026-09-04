import UIKit
import SwiftUI

/// The session list, drawn natively.
///
/// The first screen in this app that is not a web view, and the first place the
/// shell makes an authenticated request of its own — `README.md` and
/// `KeyStore.swift` both say where that line moved and why. Everything it needs
/// was built to be handed to it: `HermitAPI` for the call, `KeyStore` for the
/// key, `SessionStatus` for the verdict, `SessionRowView` for the pixels.
///
/// ## One query
///
/// `chat.listSessions`, and nothing else. The server sorts by `sessionRecencyMs`
/// and caps at 200; this renders that order untouched. Re-sorting here would be
/// a second implementation of a key that has already been got wrong twice on the
/// web (see the comment in `routers/chat.ts`), and it would be wrong in a way
/// only a screenshot could catch.
final class SessionListViewController: UIViewController {
    private enum Section { case main }

    private var collection: UICollectionView!
    private var source: UICollectionViewDiffableDataSource<Section, SessionListItem>!
    private let refresh = UIRefreshControl()
    private let message = UILabel()

    /// The row `bg-sidebar-accent` is drawn on. Nothing sets it yet — the list
    /// is not the front door — but the row already knows how to draw it.
    var activeSessionId: String?

    private var items: [SessionListItem] = []
    private var inFlight: Task<Void, Never>?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Sessions"
        // `--sidebar`, through the generated contract rather than as two numbers
        // typed here — a hand-copied colour is exactly the drift WebContract
        // exists to end, and this one would have been invisible: a background
        // half a percent off the web's reads as "correct" in every screenshot.
        view.backgroundColor = UIColor { traits in
            UIColor(WebContract.sidebar.resolve(traits.userInterfaceStyle == .dark ? .dark : .light))
        }

        var config = UICollectionLayoutListConfiguration(appearance: .plain)
        // The row draws its own rounded background; a separator would cut
        // through it, and the web list has none.
        config.showsSeparators = false
        config.backgroundColor = .clear
        collection = UICollectionView(
            frame: .zero,
            collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config)
        )
        collection.backgroundColor = .clear
        collection.delegate = self
        collection.translatesAutoresizingMaskIntoConstraints = false
        // The web list is `px-2` inside the sidebar; the row's own px-2.5 is on
        // top of that.
        collection.contentInset = UIEdgeInsets(top: 4, left: 0, bottom: 12, right: 0)
        view.addSubview(collection)

        message.numberOfLines = 0
        message.textAlignment = .center
        message.font = .preferredFont(forTextStyle: .footnote)
        message.textColor = .secondaryLabel
        message.translatesAutoresizingMaskIntoConstraints = false
        message.isHidden = true
        view.addSubview(message)

        NSLayoutConstraint.activate([
            collection.topAnchor.constraint(equalTo: view.topAnchor),
            collection.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            collection.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            collection.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            message.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
        ])

        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, SessionListItem> {
            [weak self] cell, _, item in
            let active = item.id == self?.activeSessionId
            cell.contentConfiguration = UIHostingConfiguration {
                SessionRowView(session: item, status: Self.status(of: item), active: active)
            }
            // The hosting configuration's own margins would add to the row's,
            // which are the web's numbers and already complete.
            .margins(.all, 0)
            var background = UIBackgroundConfiguration.clear()
            background.backgroundColor = .clear
            cell.backgroundConfiguration = background
        }
        source = UICollectionViewDiffableDataSource(collectionView: collection) { view, indexPath, item in
            view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: item)
        }

        refresh.addTarget(self, action: #selector(pulled), for: .valueChanged)
        collection.refreshControl = refresh
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The container hides the bar for the web view, which draws its own
        // header. A native screen wants it back — and has to put it away again,
        // because the web view is still in this stack.
        navigationController?.setNavigationBarHidden(false, animated: animated)
        load()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(true, animated: animated)
        }
        inFlight?.cancel()
    }

    // MARK: - Loading

    @objc private func pulled() { load() }

    /// One call, replacing whatever was in flight.
    ///
    /// Cancelling rather than queueing: two overlapping polls can land in either
    /// order, and the older one landing last would put a stale list on screen
    /// with nothing to say it had.
    private func load() {
        guard let entry = KeyStore.active() else {
            refresh.endRefreshing()
            show(items: [])
            message.text = "No machine key on this device yet.\n"
                + "Sign in on the web view first — the list reads the same keyring."
            message.isHidden = false
            return
        }
        inFlight?.cancel()
        let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
        inFlight = Task { [weak self] in
            do {
                let rows = try await api.query("chat.listSessions", as: [SessionListItem].self)
                if Task.isCancelled { return }
                await MainActor.run {
                    guard let self else { return }
                    self.refresh.endRefreshing()
                    self.show(items: rows)
                    self.message.isHidden = !rows.isEmpty
                    if rows.isEmpty { self.message.text = "No conversations on this machine yet." }
                }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run {
                    guard let self else { return }
                    self.refresh.endRefreshing()
                    // The error, not a shrug. Every way this fails —— a wrong
                    // key, a server that moved, no network — reads identically
                    // as an empty list, and the text is the whole diagnosis.
                    self.message.text = "Could not load the session list.\n\(error.localizedDescription)"
                    self.message.isHidden = false
                }
            }
        }
    }

    private func show(items rows: [SessionListItem]) {
        items = rows
        var snapshot = NSDiffableDataSourceSnapshot<Section, SessionListItem>()
        snapshot.appendSections([.main])
        snapshot.appendItems(rows, toSection: .main)
        source.apply(snapshot, animatingDifferences: !rows.isEmpty)
    }

    /// The verdict, with the options a list row can honestly supply.
    ///
    /// `liveWorking` and `needsYou` are deliberately absent: both are things
    /// only a view holding the session's MESSAGES can see, and the web row does
    /// not pass them either unless a chat pane is open on that session. Claiming
    /// them here would light a dot on a guess.
    private static func status(of item: SessionListItem) -> StatusView {
        SessionStatus.view(item.statusRow, StatusOptions(unread: item.unread))
    }
}

extension SessionListViewController: UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        guard let item = source.itemIdentifier(for: indexPath) else { return }
        // Hand it to the page, the same route a Live Activity tap takes, and get
        // out of the way. The timeline is M4; until it exists this list is a
        // faster front door onto the same web screen, not a replacement for it.
        let web = navigationController?.viewControllers
            .lazy.compactMap({ $0 as? WebViewController }).first
        guard let web else { return }
        web.openDeepLink("/chat?session=\(item.id)")
        navigationController?.popToViewController(web, animated: true)
    }
}
