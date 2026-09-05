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
///
/// ## Every five seconds, while you are looking at it
///
/// The web sidebar polls that query on a 5s `refetchInterval` and stops while
/// its tab is in the background (React Query's `refetchIntervalInBackground` is
/// `false` by default). Both halves are copied here. Without the first, this
/// screen is a photograph of whenever you happened to open it — a session that
/// finished thirty seconds ago still shows an amber dot. Without the second, a
/// phone in a pocket wakes a radio every five seconds for a list nobody is
/// reading.
final class SessionListViewController: UIViewController {
    private enum Section { case main }

    /// Why a load was asked for. Only `poll` is allowed to be skipped, and only
    /// `manual` owns the refresh spinner.
    private enum Trigger { case appear, manual, poll, foreground }

    /// Rows are identified by their session id, NOT by the row value.
    ///
    /// `SessionListItem` is `Hashable` over every field it declares, so a
    /// diffable snapshot keyed by the value itself treats "the same session,
    /// one second older" as a different row: delete plus insert. That reads as
    /// a wobble on a manual refresh and as the entire list flickering every
    /// five seconds once it polls — `snapshotAt` moves on every live session
    /// between one poll and the next. Keyed by id, the same row stays the same
    /// row and is reconfigured in place.
    private var collection: UICollectionView!
    private var source: UICollectionViewDiffableDataSource<Section, String>!
    private let refresh = UIRefreshControl()
    private let message = UILabel()
    private let skeleton = UIHostingController(rootView: SessionListSkeleton())

    /// The row `bg-sidebar-accent` is drawn on. Nothing sets it yet — the list
    /// is not the front door — but the row already knows how to draw it.
    var activeSessionId: String?

    private var order: [String] = []
    private var itemsById: [String: SessionListItem] = [:]
    private var inFlight: Task<Void, Never>?
    private var poll: Timer?
    /// Has any answer at all landed — rows, an empty list, an error, or "no key
    /// on this device"? Until one has, the screen shows the skeleton, and after
    /// one it never comes back: a poll refreshing a list that is already drawn
    /// must not blank it.
    private var settled = false {
        didSet { skeleton.view.isHidden = settled }
    }

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

        // The empty state and every failure, in the web's own typography:
        // `px-2 py-2 text-xs text-muted-foreground`, left-aligned and directly
        // under the header — not centred in the screen, which is a native habit
        // the web list does not have.
        message.numberOfLines = 0
        message.textAlignment = .natural
        message.font = .systemFont(ofSize: 12)
        message.textColor = UIColor { traits in
            UIColor(WebContract.mutedForeground.resolve(traits.userInterfaceStyle == .dark ? .dark : .light))
        }
        message.translatesAutoresizingMaskIntoConstraints = false
        message.isHidden = true
        view.addSubview(message)

        addChild(skeleton)
        skeleton.view.backgroundColor = .clear
        skeleton.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(skeleton.view)
        skeleton.didMove(toParent: self)

        NSLayoutConstraint.activate([
            collection.topAnchor.constraint(equalTo: view.topAnchor),
            collection.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            collection.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            collection.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            // px-2 inside the list's own px-2, and py-2 below the bar.
            message.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            skeleton.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            skeleton.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            skeleton.view.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            skeleton.view.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
        ])

        let cell = UICollectionView.CellRegistration<UICollectionViewListCell, String> {
            [weak self] cell, _, id in
            guard let item = self?.itemsById[id] else { return }
            let active = id == self?.activeSessionId
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
        source = UICollectionViewDiffableDataSource(collectionView: collection) { view, indexPath, id in
            view.dequeueConfiguredReusableCell(using: cell, for: indexPath, item: id)
        }

        refresh.addTarget(self, action: #selector(pulled), for: .valueChanged)
        collection.refreshControl = refresh

        // Leaving the app is not `viewWillDisappear` — the view controller stays
        // on screen, so without these two the timer would keep firing in the
        // background.
        NotificationCenter.default.addObserver(
            self, selector: #selector(leftForeground),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(cameBackToForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The container hides the bar for the web view, which draws its own
        // header. A native screen wants it back — and has to put it away again,
        // because the web view is still in this stack.
        navigationController?.setNavigationBarHidden(false, animated: animated)
        load(.appear)
        startPolling()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if navigationController?.topViewController !== self {
            navigationController?.setNavigationBarHidden(true, animated: animated)
        }
        stopPolling()
        cancelInFlight()
    }

    deinit {
        poll?.invalidate()
    }

    // MARK: - Polling

    @objc private func leftForeground() {
        stopPolling()
        cancelInFlight()
    }

    @objc private func cameBackToForeground() {
        // Only if this screen is the one being come back to. A list buried under
        // the web view has no business fetching.
        guard view.window != nil else { return }
        load(.foreground)
        startPolling()
    }

    private func startPolling() {
        stopPolling()
        // A second of tolerance: the phone gets to line this up with whatever
        // else it was going to wake for, and five seconds either way is not
        // something a human reads off a list of relative timestamps.
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.load(.poll) }
        timer.tolerance = 1
        RunLoop.main.add(timer, forMode: .common)
        poll = timer
    }

    private func stopPolling() {
        poll?.invalidate()
        poll = nil
    }

    // MARK: - Loading

    @objc private func pulled() { load(.manual) }

    private func cancelInFlight() {
        inFlight?.cancel()
        inFlight = nil
    }

    /// One call at a time.
    ///
    /// A poll waits its turn rather than displacing the request in front of it:
    /// cancel-and-reissue every five seconds means a request that takes six
    /// never lands at all, so the list would stay empty forever on exactly the
    /// connection that needs it most. Everything else — appearing, pulling,
    /// coming back to the foreground — is a person asking for it now, and
    /// replaces whatever was in flight, because two overlapping answers can
    /// arrive in either order and the older one landing last would put a stale
    /// list on screen with nothing to say it had.
    private func load(_ trigger: Trigger) {
        if trigger == .poll, let running = inFlight, !running.isCancelled { return }
        guard let entry = KeyStore.active() else {
            // Whatever was in flight was asked on behalf of a key that is now
            // gone; letting it land would redraw the rows over this sentence.
            cancelInFlight()
            refresh.endRefreshing()
            show(items: [])
            settled = true
            message.text = "No machine key on this device yet.\n"
                + "Sign in on the web view first — the list reads the same keyring."
            message.isHidden = false
            return
        }
        cancelInFlight()
        let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
        inFlight = Task { [weak self] in
            do {
                let rows = try await api.query("chat.listSessions", as: [SessionListItem].self)
                if Task.isCancelled { return }
                await MainActor.run {
                    guard let self else { return }
                    self.inFlight = nil
                    self.settled = true
                    self.refresh.endRefreshing()
                    self.show(items: rows)
                    self.message.isHidden = !rows.isEmpty
                    // `no chats yet — start a New chat.`, the web's own sentence.
                    if rows.isEmpty { self.message.text = "no chats yet — start a New chat." }
                }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run {
                    guard let self else { return }
                    self.inFlight = nil
                    self.settled = true
                    self.refresh.endRefreshing()
                    // A poll that fails over a list already on screen changes
                    // nothing: the rows stay, and so does the last thing they
                    // said. The web does the same — a failed refetch leaves
                    // `data` alone — and the alternative is a tunnel wiping a
                    // perfectly good screen.
                    guard self.order.isEmpty else { return }
                    // The error, not a shrug. Every way this fails — a wrong
                    // key, a server that moved, no network — reads identically
                    // as an empty list, and the text is the whole diagnosis.
                    self.message.text = "Could not load the session list.\n\(error.localizedDescription)"
                    self.message.isHidden = false
                }
            }
        }
    }

    private func show(items rows: [SessionListItem]) {
        let previous = itemsById
        order = rows.map(\.id)
        itemsById = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        var snapshot = NSDiffableDataSourceSnapshot<Section, String>()
        snapshot.appendSections([.main])
        snapshot.appendItems(order, toSection: .main)
        // Rows that were already on screen and now say something different are
        // redrawn where they are. Only rows that arrived or left animate.
        let changed = order.filter { id in
            guard let was = previous[id] else { return false }
            return was != itemsById[id]
        }
        if !changed.isEmpty { snapshot.reconfigureItems(changed) }
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
        guard let id = source.itemIdentifier(for: indexPath) else { return }
        // Hand it to the page, the same route a Live Activity tap takes, and get
        // out of the way. The timeline is M4; until it exists this list is a
        // faster front door onto the same web screen, not a replacement for it.
        let web = navigationController?.viewControllers
            .lazy.compactMap({ $0 as? WebViewController }).first
        guard let web else { return }
        web.openDeepLink("/chat?session=\(id)")
        navigationController?.popToViewController(web, animated: true)
    }
}
