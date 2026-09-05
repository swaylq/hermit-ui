import UIKit
import SwiftUI

/// The chat timeline, drawn natively. The skeleton of M4.
///
/// ## Not the front door yet
///
/// Reached only through `hermit://timeline/<session id>`, exactly the way the
/// native session list was introduced: a new screen goes up on a URL first, so
/// it can be walked through and screenshotted without becoming the thing every
/// tap lands on. Tapping a row in the list still opens the web chat page.
///
/// The composer is here as of round 6, so this screen can now hold a
/// conversation — but only the typed half of one. Attachments, press-to-talk and
/// dictation are still the web's alone, and the day a list row lands HERE is the
/// day those stop existing on a phone. So the front door does not move until M5
/// is finished; the switch is one line in `SessionListViewController` and it is
/// written down as its own checklist item rather than taken early.
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

    // MARK: The header
    //
    // The screen draws its own instead of using the navigation bar's title. Two
    // reasons, both in `ChatHeaderView`: the web's chat header is opaque, and it
    // carries a second line the bar has nowhere to put.

    private var headerHost: UIHostingController<ChatHeaderView>!
    /// The last `chat.getSession`. Nil until the first one lands, which is what
    /// `ChatHeaderModel.pending` is for.
    private var meta: SessionMeta?
    /// The newest `event: status` frame off the stream. Folded into `meta` by
    /// `SessionStatus.merge`, which is the same thing the web's `statusRow` does
    /// — it is the fast half, and the poll below only ever covers the gap.
    private var pushedStatus: LiveStatusFrame?
    private var metaTask: Task<Void, Never>?
    /// `chat.getSession` on the web's own `refetchInterval`.
    private var metaPoll: Timer?

    // MARK: The composer
    //
    // `ComposerCore` decides everything it says and does; this controller only
    // supplies the facts and performs the two mutations. See ComposerView for
    // what is deliberately not drawn yet.

    private var composerHost: UIHostingController<ComposerStack>!
    private let composer = ComposerState(draft: "", model: ComposerModel(
        placeholder: "", canSend: false, sending: false,
        showStop: false, stopping: false, disabled: false, notice: nil, bottomInset: 0
    ))
    /// Sends in the air. A count and not a flag: the web serialises sends but
    /// does not block on them, so two can be outstanding at once.
    private var sending = 0
    /// `cancelTurn` is in the air.
    private var stopping = false
    /// Sends run in the order they were pressed. The web chains them on one
    /// promise for the same reason: two messages typed a second apart must reach
    /// the gateway in that order, and `Task` gives no such guarantee on its own.
    private var sendChain: Task<Void, Never>?
    /// The bottom padding the composer adds under its row: the home indicator's
    /// safe area while the keyboard is down, nothing while it is up. `max()`, not
    /// stacked — the web's `pwa-pb-safe` does the same.
    private var composerBottomInset: CGFloat = 0

    // MARK: The waiting queue
    //
    // Messages sent behind a running turn. `QueueCore` decides what the strip
    // shows; these five fields are the facts it reads, and they are the web's
    // five (`queue.data`, `starterIds`, `removedQueueIds`, `optimisticQueue`,
    // `clearQueue.isPending`) under the same names where the name still fits.

    /// `chat.queue` as it last answered — the server's own list, unfiltered.
    private var queueRows: [QueueCore.Row] = []
    /// Ids of messages that ARE the running turn rather than queued behind it,
    /// hidden until the gateway picks them up. See `QueueCore.display`.
    private var queueStarters: Set<String> = []
    /// Rows pulled by the reader, hidden before `chat.dequeue` answers.
    private var queueCancelled: Set<String> = []
    /// Sends made during a running turn that the queue has not reported yet.
    /// Kept apart from `outgoing` exactly as the web keeps `optimisticQueue`
    /// apart from `pending`: a send made while NOTHING was running belongs in
    /// the timeline only, because it is the turn, not a thing waiting for one.
    private var queueOptimistic: [ComposerCore.Optimistic] = []
    /// `chat.clearQueue` is in the air.
    private var queueClearing = false
    private var queueTask: Task<Void, Never>?
    private var queuePoll: Timer?

    /// The LIVE window, oldest-first — the newest `WebContract.timelineLimit`
    /// rows, and the only rows the stream carries. Kept apart from the fold's
    /// output so a push re-folds from the same rows the server sent rather than
    /// from something already grouped into capsules.
    private var window: [FoldInput] = []
    /// History paged in below the window, oldest-first. Grows upwards, one
    /// `chat.listMessagesBefore` page at a time, and absorbs whatever the window
    /// sheds while it is on screen.
    private var older: [FoldInput] = []
    /// Messages this screen has SENT and not yet seen come back.
    ///
    /// Drawn at the bottom of the conversation the instant the send button is
    /// pressed, and retired by `ComposerCore.dropLanded` once the real row lands
    /// — by the id `chat.send` answered with, or by text in the second before it
    /// answers. The web calls these `pending`; the name here is `outgoing`
    /// because `pending` is already taken on this class, by the stream frames
    /// held while the window query is in the air.
    private var outgoing: [ComposerCore.Optimistic] = []

    /// Window + history + what we have just said, which is the conversation the
    /// fold is run over.
    ///
    /// The optimistic rows go LAST because they are the newest by construction:
    /// the fold reads the list oldest-first, and a bubble that jumped above the
    /// reply it is waiting for would be a worse lie than a slow one.
    private var allInputs: [FoldInput] { older + window + outgoing.map(Self.foldInput) }
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

        composer.draft = ComposerDraft.load(sessionId)
        composerHost = UIHostingController(rootView: ComposerStack(
            state: composer,
            onSend: { [weak self] in self?.sendDraft() },
            onStop: { [weak self] in self?.stopTurn() },
            onClear: { [weak self] in self?.setDraft("") },
            onDismissNotice: { [weak self] in self?.setNotice(nil) },
            onDraftChange: { [weak self] value in self?.draftChanged(value) },
            onCancelQueued: { [weak self] id in self?.cancelQueued(id) },
            onClearQueue: { [weak self] in self?.clearQueue() }
        ))
        composerHost.view.translatesAutoresizingMaskIntoConstraints = false
        composerHost.view.backgroundColor = .clear
        // The host's view has no height of its own: the collection's bottom is
        // pinned to its top and the whole bottom of the screen is however tall
        // SwiftUI says it is. Without this, that measurement is taken once and
        // never RETAKEN — the composer's own growth was inside the first
        // measurement, but the queue strip appearing is not, so the content
        // overflowed upward, drew over the conversation, and the part of it
        // outside the view's bounds took no touches. The ✕ on a queued line
        // worked (it sits low enough to be inside) and 清空队列 at the top of the
        // card did nothing at all — a control that is plainly there, plainly
        // enabled, and dead. Nothing but the simulator can see this: every
        // render on the Mac draws SwiftUI with no UIKit bounds around it.
        composerHost.sizingOptions = .intrinsicContentSize
        addChild(composerHost)
        view.addSubview(composerHost.view)
        composerHost.didMove(toParent: self)
        // The composer owns the bottom safe area itself (see `bottomInset`), so
        // the guide has to stop reserving it — otherwise the home indicator is
        // paid for twice and the box floats on an empty band.
        view.keyboardLayoutGuide.usesBottomSafeArea = false

        headerHost = UIHostingController(rootView: ChatHeaderView(model: pendingHeaderModel, onBack: nil))
        headerHost.view.translatesAutoresizingMaskIntoConstraints = false
        headerHost.view.backgroundColor = .clear
        addChild(headerHost)
        view.addSubview(headerHost.view)
        headerHost.didMove(toParent: self)

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
            // Below the status bar, not under it — the web's app shell pads
            // itself by `env(safe-area-inset-top)` and the strip above is plain
            // `bg-background`, which is what `view.backgroundColor` already is.
            headerHost.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            headerHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            headerHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            headerHost.view.heightAnchor.constraint(equalToConstant: ChatHeaderMetrics.height),
            // The list starts BELOW the header rather than scrolling behind it.
            // The web's header is a `shrink-0` flex item over its own scroller,
            // and the difference is visible at the edges: content sliding under
            // an opaque bar still moves the scroll indicator and the rubber-band
            // through it.
            collection.topAnchor.constraint(equalTo: headerHost.view.bottomAnchor),
            collection.bottomAnchor.constraint(equalTo: composerHost.view.topAnchor),
            collection.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collection.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            // Pinned to the keyboard, not to the safe area: `keyboardLayoutGuide`
            // collapses to the bottom of the view when there is no keyboard, so
            // one constraint covers both states and animates between them on
            // UIKit's own curve — which is the point, since the web's box is
            // carried by the browser's visual viewport and moves on the same one.
            composerHost.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            composerHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            message.topAnchor.constraint(equalTo: headerHost.view.bottomAnchor, constant: 16),
            message.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Self.padH),
            message.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -Self.padH),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: collection.centerYAnchor),
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
    /// alone it adds its top inset at content-top, which lands as dead space
    /// under the newest message while the oldest rows run off the other end with
    /// `padV` and nothing else. That is what the first simulator run of this
    /// screen looked like.
    ///
    /// Fixed by cancelling out what UIKit contributes rather than by turning the
    /// adjustment off: `adjustedContentInset = safeAreaInsets + contentInset`, so
    /// asking for the two ends swapped is arithmetic. The alternative —
    /// `contentInsetAdjustmentBehavior = .never` — also means owning the resting
    /// content offset by hand, and writing `contentOffset` from inside a layout
    /// pass is exactly the re-entrancy that killed `scrollViewDidScroll`.
    ///
    /// Read off `collection.safeAreaInsets` and not the view controller's: since
    /// the header went in, the collection starts below it and UIKit therefore
    /// contributes NOTHING at its top edge. Deriving the correction from the
    /// number UIKit will actually add keeps this right whichever of the two is
    /// true, rather than hard-coding today's answer.
    ///
    /// A negative `bottom` is fine and expected — that end is the top of the
    /// screen, which the header already covers.
    private func applyInsets() {
        // `own.top` is added at content-top (the bottom of the screen) and
        // `own.bottom` at content-bottom (just under the header): the flip does
        // not reach the safe area, which is why they have to be swapped here.
        //
        // Since the composer went in, the list is bounded by two opaque bars and
        // reaches neither end of the screen, so `own` is zero on both edges and
        // the home indicator is the composer's to clear. The correction is still
        // computed from `own` rather than assumed zero: whichever of the two is
        // true, `adjustedContentInset = safeAreaInsets + contentInset` holds, and
        // arithmetic that stays right through a layout change is worth one
        // subtraction.
        let own = collection.safeAreaInsets
        let wanted = UIEdgeInsets(top: Self.padV - own.top, left: 0,
                                  bottom: Self.padV - own.bottom, right: 0)
        guard collection.contentInset != wanted else { return }
        collection.contentInset = wanted
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // `viewSafeAreaInsetsDidChange` fires on THIS view; the collection's own
        // insets settle a layout pass later, and it is those the correction is
        // computed from. Cheap — `applyInsets` returns without touching anything
        // when the answer has not moved.
        applyInsets()
        // Whether the keyboard is up, read off the guide rather than off a pair
        // of notifications: the guide is already the thing the composer is
        // pinned to, so this cannot disagree with where the box actually is —
        // and it stays right during the animation, which two notifications
        // bracketing it do not.
        let keyboard = max(0, view.bounds.maxY - view.keyboardLayoutGuide.layoutFrame.minY)
        let wanted = keyboard > 0 ? 0 : view.safeAreaInsets.bottom
        // Guarded: assigning it would publish, and publishing inside a layout
        // pass that has not finished is how a SwiftUI host ends up laying out
        // twice per frame.
        guard wanted != composerBottomInset else { return }
        composerBottomInset = wanted
        refreshComposer()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Hidden, unlike the session list: this screen draws its own header, and
        // showing UIKit's as well would put two titles on top of each other. The
        // edge-swipe back still works — `SceneDelegate.gestureRecognizerShouldBegin`
        // answers for a hidden bar, which is the whole reason it exists.
        navigationController?.setNavigationBarHidden(true, animated: animated)
        refreshHeader()
        refreshComposer()
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

    private struct SessionInput: Encodable {
        let sessionId: String
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
        loadMeta(origin: base)
        startMetaPoll(origin: base)
        loadQueue(origin: base)
        startQueuePoll(origin: base)
    }

    // MARK: - The header's own query

    /// What the header shows before `chat.getSession` has answered.
    private var pendingHeaderModel: ChatHeaderModel {
        ChatHeaderModel.pending(sessionId: sessionId, title: title_)
    }

    /// `chat.getSession`, which is where the meta line comes from.
    ///
    /// A different route from the list's `chat.listSessions`, and it has to be:
    /// the list payload deliberately carries no `activity` blob (the server's own
    /// rule — that query polls every 5s for every open page), so "Bash · 47s"
    /// exists only here. Failure is silent: the header keeps whatever it had, or
    /// the id, and the timeline below it is the thing that reports a broken
    /// connection.
    private func loadMeta(origin: URL) {
        let api = HermitAPI(origin: origin, key: { KeyStore.active()?.key ?? "" })
        let input = SessionInput(sessionId: sessionId)
        metaTask?.cancel()
        metaTask = Task { [weak self] in
            // `getSession` answers `null` for a session this key cannot see, so
            // the payload is optional and `try?` flattens the refusal into the
            // same nothing. Two levels of optional, one meaning: no header data.
            let got = try? await api.query("chat.getSession", input: input, as: SessionMeta?.self)
            if Task.isCancelled { return }
            await MainActor.run {
                guard let self else { return }
                self.metaTask = nil
                guard let row = got ?? nil else { return }
                self.meta = row
                self.refreshHeader()
                self.refreshComposer()
            }
        }
    }

    private func startMetaPoll(origin: URL) {
        metaPoll?.invalidate()
        // Same 5s the web's `getSession` query uses. `.common` so it keeps
        // running while the timeline is being dragged — a header that freezes
        // mid-scroll is the one moment a reader is most likely to look at it.
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.metaTask == nil else { return }
            self.loadMeta(origin: origin)
        }
        RunLoop.main.add(timer, forMode: .common)
        metaPoll = timer
    }

    /// Rebuild the header from whatever is known right now.
    ///
    /// The pushed frame is folded in by `SessionStatus.merge`, which prefers the
    /// polled row on a tie — the same rule the web's `statusRow` follows, and the
    /// reason `event: status` is worth consuming at all: it moves the dot the
    /// moment the gateway writes, instead of up to five seconds later.
    @MainActor
    private func refreshHeader() {
        guard headerHost != nil else { return }
        var model: ChatHeaderModel
        if let meta {
            model = ChatHeaderModel(meta: meta, sessionId: sessionId)
            if let merged = SessionStatus.merge(meta.statusRow, pushedStatus) {
                // `liveWorking` is this screen's own read of the conversation,
                // and it is why the dot turns the instant you press send instead
                // of when the gateway's next snapshot lands. The web passes the
                // same flag (`liveWorking: isInFlight`); until round 6 this
                // header did not, so its dot was up to five seconds late on
                // exactly the message the reader was watching for.
                model.status = SessionStatus.view(merged, StatusOptions(liveWorking: liveWorking, unread: false))
            }
        } else {
            model = pendingHeaderModel
        }
        // No back control when there is nothing to pop to. Today the timeline is
        // always pushed, but it was the root for five rounds and may be again.
        let canPop = (navigationController?.viewControllers.count ?? 0) > 1
        headerHost.rootView = ChatHeaderView(
            model: model,
            onBack: canPop ? { [weak self] in self?.navigationController?.popViewController(animated: true) } : nil
        )
    }

    // MARK: - The waiting queue

    /// `chat.queue`: the user messages the gateway has not picked up yet,
    /// oldest first.
    ///
    /// A separate route from `chat.listMessages` on purpose, and the server says
    /// why: that query is the hot one and skips `deliveredAt` entirely. So the
    /// strip is the only thing on this screen that knows a message has been
    /// written and not started — the timeline draws it as an ordinary bubble.
    private func loadQueue(origin: URL) {
        let api = HermitAPI(origin: origin, key: { KeyStore.active()?.key ?? "" })
        let input = SessionInput(sessionId: sessionId)
        queueTask?.cancel()
        queueTask = Task { [weak self] in
            let got = try? await api.query("chat.queue", input: input, as: [QueuedMessage].self)
            if Task.isCancelled { return }
            await MainActor.run {
                guard let self else { return }
                self.queueTask = nil
                // Silent on failure, like the header's own poll: the strip keeps
                // what it had, and a broken connection is the timeline's news to
                // break, not this one's.
                guard let got else { return }
                self.adopt(queue: got.map { QueueCore.Row(id: $0.id, content: $0.content) })
            }
        }
    }

    /// A fresh answer from `chat.queue`, and the three bits of local memory it
    /// settles.
    @MainActor
    private func adopt(queue rows: [QueueCore.Row]) {
        queueRows = rows
        let live = rows.map(\.id)
        // Both hidden sets shrink to what is still queued — see
        // `QueueCore.pruneToLive` for why that is the right direction.
        queueStarters = QueueCore.pruneToLive(queueStarters, live: live)
        queueCancelled = QueueCore.pruneToLive(queueCancelled, live: live)
        // A stub whose real row is now in the queue has landed. Against the RAW
        // list, starters included.
        queueOptimistic = ComposerCore.dropLanded(
            queueOptimistic, landed: rows.map { (id: $0.id, content: $0.content) }
        )
        refreshQueue()
        // The strip's length is a rung on the composer's ladder.
        refreshComposer()
    }

    /// The web's `refetchInterval`, as a timer.
    ///
    /// It fires on the poll's own period and each tick ASKS `QueueCore` whether
    /// to make the request at all — which is what react-query's callback does
    /// there. Leaving the timer running while the answer is "no" costs one
    /// comparison every two seconds and means the moment a turn starts, the next
    /// tick is already scheduled.
    private func startQueuePoll(origin: URL) {
        queuePoll?.invalidate()
        let timer = Timer(timeInterval: QueueCore.pollMs / 1000, repeats: true) { [weak self] _ in
            guard let self, self.queueTask == nil else { return }
            guard QueueCore.pollInterval(inFlight: self.liveWorking,
                                         serverCount: self.queueRows.count) != nil else { return }
            self.loadQueue(origin: origin)
        }
        RunLoop.main.add(timer, forMode: .common)
        queuePoll = timer
    }

    /// What the strip shows right now.
    private var displayQueue: [QueueCore.Row] {
        QueueCore.display(server: queueRows,
                          starters: queueStarters,
                          cancelled: queueCancelled,
                          optimistic: queueOptimistic)
    }

    /// Rebuild the strip. Cheap and idempotent, like `refreshComposer`.
    @MainActor
    private func refreshQueue() {
        guard composerHost != nil else { return }
        let model = QueueBarModel(
            items: displayQueue.map {
                QueueBarItem(id: $0.id, label: QueueCore.itemLabel(ComposerCore.msgText($0.content)))
            },
            clearing: queueClearing
        )
        guard model != composer.queue else { return }
        composer.queue = model
    }

    /// The ✕ on one queued line.
    ///
    /// Two different actions behind one glyph, and `QueueCore.cancelTarget`
    /// picks: a stub this screen invented just goes away, while a real row takes
    /// a `chat.dequeue` — which can come back `removed: false`, meaning the
    /// gateway got there first. That row is then history, not rubbish, so it is
    /// put back rather than left hidden.
    private func cancelQueued(_ id: String) {
        switch QueueCore.cancelTarget(id: id, optimisticIds: queueOptimistic.map(\.id)) {
        case .local:
            queueOptimistic.removeAll { $0.id == id }
            refreshQueue()
            refreshComposer()
        case .server:
            guard let entry = KeyStore.active() else { return }
            let restore = { [weak self] in
                guard let self else { return }
                self.queueCancelled.remove(id)
                self.refreshQueue()
                self.refreshComposer()
            }
            // Hide it NOW rather than after the round trip: the reader has just
            // said they do not want it, and a line that sits there for a second
            // afterwards reads as the tap having missed.
            queueCancelled.insert(id)
            refreshQueue()
            refreshComposer()
            let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
            Task { [weak self] in
                let got = try? await api.mutate("chat.dequeue",
                                                input: DequeueInput(messageId: id),
                                                as: DequeueResult.self)
                await MainActor.run {
                    guard let self else { return }
                    if got?.removed != true { restore() }
                    if let e = KeyStore.active() { self.loadQueue(origin: KeyStore.base(for: e)) }
                }
            }
        }
    }

    /// Empty the queue.
    ///
    /// The stubs go immediately — nothing on a server can answer for them — and
    /// the real rows stay until the poll says they are gone, which is the web's
    /// behaviour: the button dims for the round trip instead of the list
    /// blanking and possibly coming back.
    private func clearQueue() {
        guard !queueClearing, let entry = KeyStore.active() else { return }
        queueOptimistic.removeAll()
        queueClearing = true
        refreshQueue()
        refreshComposer()
        let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
        let input = SessionInput(sessionId: sessionId)
        Task { [weak self] in
            _ = try? await api.mutate("chat.clearQueue", input: input, as: ClearQueueResult.self)
            await MainActor.run {
                guard let self else { return }
                self.queueClearing = false
                self.refreshQueue()
                if let e = KeyStore.active() { self.loadQueue(origin: KeyStore.base(for: e)) }
            }
        }
    }

    /// One row of `chat.queue`. `createdAt` is selected by the server and not
    /// read here — the strip's order is the server's, oldest first.
    private struct QueuedMessage: Decodable {
        let id: String
        let content: JSONValue
    }

    private struct DequeueInput: Encodable { let messageId: String }
    /// `removed: false` means the gateway had already delivered it.
    private struct DequeueResult: Decodable { let removed: Bool }
    private struct ClearQueueResult: Decodable { let removed: Int }

    // MARK: - The composer

    /// One outgoing message, as a row the fold can draw.
    ///
    /// `role: "user"` and a text block, which is exactly what `chat.send` will
    /// write — so the optimistic bubble and the real row fold into the same
    /// shape and the swap between them is invisible.
    private static func foldInput(_ o: ComposerCore.Optimistic) -> FoldInput {
        FoldInput(id: o.id, role: "user", content: o.content,
                  createdAt: isoNow.string(from: Date()), authoredBy: nil)
    }

    /// Timestamps for optimistic rows, in the format the server sends —
    /// `HermitAPI.isoDate` reads it back, and the fold's day dividers order by it.
    private static let isoNow: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f
    }()

    /// The clock the composer's own state is judged against. One property so a
    /// test can move it; nothing else in this class needs it.
    private var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// What `turnInFlight` sees right now.
    ///
    /// `streamingTail` is `false` and that is a KNOWN gap, not an oversight: the
    /// web watches the tail assistant row's JSON grow between polls and holds
    /// "in flight" for 1.8s after each growth. Nothing here tracks that yet, so
    /// the fast local signal covers only "I just sent and nobody has answered".
    /// The rest arrives through `statusKey == "working"`, which is the gateway's
    /// own view and is at most one 5s poll behind — late, not wrong. Its own
    /// checklist line.
    private var turnSignals: ComposerCore.TurnSignals {
        let status = SessionStatus.merge(meta?.statusRow, pushedStatus)
        let last = window.last ?? older.last
        return ComposerCore.TurnSignals(
            statusState: status?.state,
            snapshotAt: status?.snapshotAt.map { $0.timeIntervalSince1970 * 1000 },
            lastRole: last?.role,
            lastAt: last.flatMap { HermitAPI.isoDate($0.createdAt)?.timeIntervalSince1970 }.map { $0 * 1000 },
            // Only the NEWEST optimistic row matters, and only its clock —
            // exactly what `pending[pending.length - 1]` is on the web.
            optimisticAt: outgoing.isEmpty ? nil : nowMs,
            streamingTail: false,
            now: nowMs
        )
    }

    /// Rebuild the composer's model from whatever is known right now.
    ///
    /// Cheap and idempotent, so every path that changes anything it reads simply
    /// calls it — the same discipline `refreshHeader` follows.
    @MainActor
    private func refreshComposer() {
        guard composerHost != nil else { return }
        let closed = meta?.closedAt != nil
        let flight = ComposerCore.turnInFlight(turnSignals)
        let stop = ComposerCore.stopPill(inFlight: flight.inFlight,
                                         statusKey: headerStatusKey,
                                         closed: closed)
        var model = composer.model
        model.disabled = closed
        model.showStop = stop.show
        model.stopping = stopping
        model.sending = sending > 0
        model.bottomInset = composerBottomInset
        let queueFull = QueueCore.isFull(displayQueue.count)
        model.placeholder = ComposerCore.placeholder(ComposerCore.Face(
            disabled: closed,
            // `awaitingInput` still cannot be true: the timeline does not draw
            // an interaction card yet (M4), so that one rung is unreachable
            // rather than wrong, and it has its own checklist line. `queueFull`
            // became reachable in round 7 — it is counted over what the strip
            // SHOWS, which is what the reader can see.
            awaitingInput: false,
            queueFull: queueFull,
            working: stop.turnRunning,
            uploadingCount: 0,
            dictating: false,
            // A phone is always touch-primary, which is the branch the web takes
            // when `isTouchPrimary()` is true.
            touch: true,
            brainGhost: false
        ))
        model.canSend = ComposerCore.canSend(
            disabled: closed, awaitingInput: false, queueFull: queueFull,
            uploadingCount: 0, draft: composer.draft, readyAttachments: 0
        )
        guard model != composer.model else { return }
        composer.model = model
    }

    /// The status key the header is showing. Read from the same merge the header
    /// runs so the pill and the dot can never disagree — the web's Stop reads
    /// `status.key` for exactly that reason.
    private var headerStatusKey: String {
        guard let meta, let merged = SessionStatus.merge(meta.statusRow, pushedStatus) else { return "" }
        return SessionStatus.view(merged, StatusOptions(liveWorking: liveWorking, unread: false)).key.rawValue
    }

    /// Working as THIS screen sees it, handed to `sessionStatusView` the way the
    /// web hands it `isInFlight`. Without it the dot waits for the gateway's
    /// snapshot — up to five seconds after you press send.
    private var liveWorking: Bool {
        ComposerCore.turnInFlight(turnSignals).inFlight
    }

    /// Typing. The value is already in `composer.draft` — the field wrote it —
    /// so this only persists it and re-decides whether the circle is live.
    private func draftChanged(_ value: String) {
        ComposerDraft.save(sessionId, value)
        refreshComposer()
    }

    /// Write the box from OUTSIDE it: the clear button, and putting the words
    /// back after a failed send.
    private func setDraft(_ value: String) {
        composer.draft = value
        ComposerDraft.save(sessionId, value)
        refreshComposer()
    }

    private func setNotice(_ text: String?) {
        guard composer.model.notice != text else { return }
        composer.model.notice = text
    }

    /// Send what is in the box.
    ///
    /// The order is the web's, and each step is load-bearing:
    ///   1. re-pin to the newest row, so the reply scrolls into view even if the
    ///      reader had wandered up the history;
    ///   2. mint the idempotency key BEFORE anything can fail, so a retry of
    ///      this exact message can never become a second message;
    ///   3. show the bubble and empty the box, because a composer that waits for
    ///      a round trip reads as broken on a slow connection;
    ///   4. send, and on failure put the words back exactly as they were.
    private func sendDraft() {
        let typed = composer.draft
        guard ComposerCore.canSend(disabled: composer.model.disabled, awaitingInput: false,
                                   queueFull: false, uploadingCount: 0,
                                   draft: typed, readyAttachments: 0) else { return }
        guard let entry = KeyStore.active() else {
            setNotice("No machine key on this device yet.")
            return
        }
        // The server trims too, and an untrimmed bubble would not match the row
        // that comes back — `dropLanded`'s text fallback compares trimmed text.
        let text = ComposerCore.jsTrim(typed)
        let clientId = ComposerCore.newClientId()
        // Is a turn ALREADY unanswered before this send? If not, this message is
        // the imminent active turn rather than something queued behind one, and
        // the strip must not flash it during the ~2s the gateway takes to pick
        // it up (see `QueueCore.display`). Read BEFORE the optimistic row goes
        // in, because `turnSignals` counts that row.
        //
        // `waitingAssistant`, not `inFlight`: the web gates on the narrower one
        // on purpose. `inFlight` also counts the streaming tail's decay, so a
        // send made right after a reply visibly ends was read as "queued" and
        // stuttered through the strip.
        let wasIdle = !ComposerCore.turnInFlight(turnSignals).waitingAssistant
        let content = JSONValue.array([.object(["type": .string("text"), "text": .string(text)])])

        scrollToTail()
        setNotice(nil)
        outgoing.append(ComposerCore.Optimistic(id: clientId, realId: nil, content: content))
        // A send made DURING a running turn is a queue item, and the strip shows
        // it now rather than on the next 2s poll.
        if !wasIdle {
            queueOptimistic.append(ComposerCore.Optimistic(id: clientId, realId: nil, content: content))
        }
        setDraft("")
        sending += 1
        refold()
        refreshQueue()
        refreshComposer()
        refreshHeader()

        let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
        let input = SendInput(sessionId: sessionId, clientId: clientId, text: text)
        let previous = sendChain
        sendChain = Task { [weak self] in
            // Serial: the gateway delivers in insert order, so two messages
            // typed a second apart must not race into the wrong one.
            _ = await previous?.result
            do {
                let sent = try await api.mutate("chat.send", input: input, as: SentMessage.self)
                await MainActor.run { self?.sendLanded(clientId: clientId, realId: sent.id, wasIdle: wasIdle) }
            } catch {
                await MainActor.run { self?.sendFailed(clientId: clientId, typed: typed, error: error) }
            }
        }
    }

    @MainActor
    private func sendLanded(clientId: String, realId: String, wasIdle: Bool) {
        sending = max(0, sending - 1)
        // Hand the bubble over to its real counterpart BY ID. It stays on screen
        // until that exact row arrives (see `ComposerCore.dropLanded`), which is
        // what keeps a send whose text the server rewrote from flickering.
        if let i = outgoing.firstIndex(where: { $0.id == clientId }) {
            outgoing[i].realId = realId
        }
        if let i = queueOptimistic.firstIndex(where: { $0.id == clientId }) {
            queueOptimistic[i].realId = realId
        }
        // Only now is the server id known, and the server id is what
        // `chat.queue` will report. A message that was the turn is remembered
        // here so the strip never shows it.
        if wasIdle { queueStarters.insert(realId) }
        dropLandedOutgoing()
        refold()
        refreshQueue()
        refreshComposer()
        // The queue has just changed on the server; ask rather than wait out the
        // poll. The web's mutation does the same thing by invalidating.
        if let e = KeyStore.active() { loadQueue(origin: KeyStore.base(for: e)) }
    }

    @MainActor
    private func sendFailed(clientId: String, typed: String, error: Error) {
        sending = max(0, sending - 1)
        outgoing.removeAll { $0.id == clientId }
        queueOptimistic.removeAll { $0.id == clientId }
        // Put back what was typed, untrimmed, exactly as it was — including a
        // trailing newline someone was in the middle of writing after.
        if composer.draft.isEmpty { setDraft(typed) }
        // Say WHY. Silently restoring the draft is what once read as "send is
        // dead"; the server's own sentence ("queue_full", "session is closed")
        // is the useful half.
        setNotice(error.localizedDescription)
        refold()
        refreshQueue()
        refreshComposer()
    }

    /// Kill the running turn.
    ///
    /// The 400ms arm delay lives in `ComposerView` where the button is, because
    /// what it guards against is a finger already travelling toward that corner.
    private func stopTurn() {
        guard !stopping, let entry = KeyStore.active() else { return }
        stopping = true
        refreshComposer()
        let api = HermitAPI(origin: KeyStore.base(for: entry), key: { KeyStore.active()?.key ?? "" })
        let input = SessionInput(sessionId: sessionId)
        Task { [weak self] in
            _ = try? await api.mutate("chat.cancelTurn", input: input, as: CancelResult.self)
            await MainActor.run {
                guard let self else { return }
                self.stopping = false
                self.refreshComposer()
                // The gateway writes `cancelRequestedAt` and the pane state
                // follows a beat later; re-asking is what turns the dot round
                // without waiting out the poll.
                if let e = KeyStore.active() { self.loadMeta(origin: KeyStore.base(for: e)) }
            }
        }
    }

    /// Retire every optimistic bubble whose real row is now on screen.
    @MainActor
    private func dropLandedOutgoing() {
        guard !outgoing.isEmpty else { return }
        let real = (older + window).map { (id: $0.id, content: $0.content) }
        outgoing = ComposerCore.dropLanded(outgoing, landed: real)
    }

    /// Back to the newest row. The list is upside down, so that is content
    /// offset zero — less whatever inset the collection adds at rest.
    private func scrollToTail() {
        collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top),
                                    animated: false)
    }

    private struct SendInput: Encodable {
        let sessionId: String
        /// The idempotency key. Optional on the wire — the browser composer sends
        /// without one — but never omitted here: a phone is the client that
        /// actually loses its connection mid-send.
        let clientId: String
        let text: String
    }

    /// `chat.send` answers with the whole row it wrote. Only the id is read: it
    /// is what the optimistic bubble is handed over to.
    private struct SentMessage: Decodable { let id: String }

    private struct CancelResult: Decodable { let ok: Bool }

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
        metaTask?.cancel()
        metaTask = nil
        metaPoll?.invalidate()
        metaPoll = nil
        queueTask?.cancel()
        queueTask = nil
        queuePoll?.invalidate()
        queuePoll = nil
        // `meta` and `pushedStatus` deliberately survive: coming back from the
        // background re-queries, and blanking the header for that round trip
        // would be a flicker with nothing behind it.
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
        case .status(let frame):
            // The fast half of the header's state. Kept as a frame rather than
            // applied to `meta`, so `SessionStatus.merge` can go on deciding
            // which of the two is later every time the header is rebuilt — a
            // frame that lost to the poll once must not win after the next one.
            pushedStatus = LiveStatusFrame(state: frame.state, alive: frame.alive,
                                           activity: frame.activity, snapshotAt: frame.snapshotAt)
            refreshHeader()
            refreshComposer()
        case .connected, .frameDropped:
            // A dropped frame is one unreadable payload on a connection that is
            // still good, and the next frame carries the row again.
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
        // Retiring landed bubbles happens HERE rather than at each of the four
        // call sites: every path that can bring a real row in ends up in this
        // method, and a bubble left standing over its own row is the one bug
        // this whole mechanism exists to prevent.
        dropLandedOutgoing()
        let all = allInputs
        show(rows: FoldRuns.fold(all))
        message.isHidden = !all.isEmpty
        if all.isEmpty { message.text = "Nothing in this conversation yet." }
        // The newest row just moved, which is half of what decides whether a
        // turn is running.
        refreshComposer()
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
