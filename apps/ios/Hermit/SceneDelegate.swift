import UIKit

/// What the app is: a navigation stack whose ROOT is the web app, with native
/// screens pushed on top of it whenever one of them is what's wanted.
///
/// ## Why the page is the root again
///
/// The dashboard's own front door is a chat. `/` redirects to `/chat`, which
/// restores `lastSessionId()` — so opening the app on a phone puts you back in
/// the conversation you were in, and the list of sessions is a DRAWER pulled
/// over it from the left (`components/app-sidebar.tsx`), not a screen you have
/// to get past.
///
/// M3 shipped the native list as the root for four rounds (round 15 through
/// round 3 of the perfect-goal pass). That made the first thing you see a page
/// the web app does not have, and it was the first thing sway said about
/// build 7. The goal since 09-05 is "the same as the web, interaction
/// included", so this reverts to the web's shape: page at the bottom, list
/// behind `hermit://sessions` where it lived before it was promoted.
///
/// **Nothing was deleted in that revert.** `SessionListViewController`,
/// `SessionListCache` and the per-entry snapshot are all still here and still
/// driven — they are what the native drawer will be built out of, and the
/// drawer is a milestone of its own. What changed is only which view controller
/// the window opens on.
///
/// ## The left edge belongs to the page
///
/// Which follows from the same decision. UIKit's interactive pop would eat the
/// drawer's pull, and the drawer is a navigation surface with no other gesture;
/// see `gestureRecognizerShouldBegin`.
///
/// ## The web view is built at launch and owned here
///
/// It is the root, so the stack retains it — but it is held here as well,
/// because a native screen that ever becomes the root again (or a stack that
/// gets reset) must not take the loaded document, the scroll position and every
/// open connection with it. `WebViewController.viewDidLoad` is what creates the
/// WKWebView and starts the load, so `loadViewIfNeeded()` also gives
/// `AppDelegate` somewhere to deliver a push token that arrives during launch.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// The web layer. **One instance for the life of the scene, owned here** and
    /// only lent to the navigation stack.
    ///
    /// Two instances would each hold their own web view, their own bridge and
    /// their own idea of which page is loaded; a zero-instance moment (popped
    /// off the stack with nobody else retaining it) would deallocate the
    /// document and reload the whole dashboard on the way back.
    private lazy var web: WebViewController = {
        let made = WebViewController()
        made.loadViewIfNeeded()
        return made
    }()

    /// The native session list. One instance, for the same reason the web view
    /// is one instance and for one more of its own: `activeSessionId` — the row
    /// drawn with `bg-sidebar-accent` because it is the session open behind the
    /// list — lives on it. A list rebuilt on every `hermit://sessions` would
    /// come back having forgotten which row you tapped, which is the web's
    /// `optimisticActiveId` quietly going missing.
    ///
    /// Built lazily, unlike the web view: it is not on the launch path any more
    /// and a cold start that never opens it should not pay for its collection
    /// view, its cache read or its poll.
    private lazy var list: SessionListViewController = {
        let made = SessionListViewController()
        // The list does not go looking for a web view; it says where it wants to
        // go and this decides what that means. See `openPath` there.
        made.openPath = { [weak self] path in self?.openPath(path) }
        // A tapped row is a session, and a session is now a native screen.
        made.openSession = { [weak self] id in self?.presentTimeline(sessionId: id, animated: true) }
        return made
    }()

    private var nav: UINavigationController? { window?.rootViewController as? UINavigationController }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let nav = UINavigationController(rootViewController: web)
        // Hidden, because the page draws its own header. Each native screen
        // turns it on in `viewWillAppear` and back off on the way out.
        nav.isNavigationBarHidden = true
        // The bar being hidden is also what stops UIKit running its own back
        // swipe, and a pushed native screen needs one. See
        // `gestureRecognizerShouldBegin` for why this cannot simply return true.
        nav.interactivePopGestureRecognizer?.delegate = self

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = nav
        window.makeKeyAndVisible()
        self.window = window

        // This is also what APNs callbacks — which may already have fired during
        // launch — get delivered to.
        web.loadViewIfNeeded()
        (UIApplication.shared.delegate as? AppDelegate)?.attach(self)

        // A tap on the Live Activity that launched us cold. The URL arrives here
        // rather than through `scene(_:openURLContexts:)`, which is only called
        // for a scene that already exists.
        if let url = connectionOptions.urlContexts.first?.url { open(url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url { open(url) }
    }

    // MARK: - The screens

    /// Bring the page forward, from wherever the stack happens to be.
    /// Idempotent: a second deep link arriving while the page is already up
    /// moves nothing.
    ///
    /// The page is the root, so this is a pop — but written as "get to `web`"
    /// rather than "pop to root", because which view controller is at the bottom
    /// is exactly the thing that has changed twice now.
    @discardableResult
    private func presentWeb(animated: Bool) -> WebViewController {
        guard let nav else { return web }
        if !nav.viewControllers.contains(web) {
            nav.setViewControllers([web], animated: animated)
        } else if nav.topViewController !== web {
            nav.popToViewController(web, animated: animated)
        }
        return web
    }

    /// Put the native session list in front of the page.
    ///
    /// Directly in front of it, and never on top of anything else. On the web
    /// this list is a drawer that opens over whichever chat you are in — it is
    /// not another floor of a stack — so `hermit://sessions` from a timeline has
    /// to read as "show me the sessions", not "and now you are three screens
    /// deep with two backs to press".
    ///
    /// Idempotent by identity, because `list` is a single instance: already on
    /// top is nothing, already in the stack is a pop back to it (which is what
    /// keeps the row you tapped marked — `activeSessionId` lives on that
    /// instance).
    ///
    /// `setViewControllers` rather than a pop followed by a push: two animated
    /// navigation transitions started in the same turn of the run loop is where
    /// UIKit's "unbalanced calls to begin/end appearance transitions" comes
    /// from, and the state it leaves behind is a stack that no longer matches
    /// what is on screen.
    private func presentList(animated: Bool) {
        guard let nav else { return }
        if nav.topViewController === list { return }
        if nav.viewControllers.contains(list) {
            nav.popToViewController(list, animated: animated)
        } else {
            nav.setViewControllers([web, list], animated: animated)
        }
    }

    /// Push the native timeline for one session.
    ///
    /// A fresh instance every time, unlike `web` and `list`: it holds a window of
    /// decoded messages and nothing that is expensive to rebuild or painful to
    /// lose — no live connection worth keeping, no scroll position anybody has
    /// grown attached to. Keeping one around per session is a cache with no
    /// eviction policy.
    private func presentTimeline(sessionId: String, animated: Bool) {
        guard let nav else { return }
        // Not on top of another timeline: opening two sessions in a row should
        // read as switching, not as a stack to back out of one screen at a time.
        if nav.topViewController is ChatTimelineViewController {
            nav.popViewController(animated: false)
        }
        let vc = ChatTimelineViewController(sessionId: sessionId)
        // A session the header's new-chat (or pure chat) button just created.
        // Same closure the list's rows use, so "opened from a row" and "opened
        // from the header" land on one code path — including the pop that keeps
        // two chats from stacking.
        vc.onOpenSession = { [weak self] id in self?.presentTimeline(sessionId: id, animated: true) }
        // Deleted: the session is gone, so go back to whatever was under it
        // rather than leaving a timeline polling a trashed id.
        vc.onSessionGone = { [weak self] in self?.nav?.popViewController(animated: true) }
        vc.onOpenPath = { [weak self] path in self?.openPath(path) }
        nav.pushViewController(vc, animated: animated)
    }

    /// The `hermit://` URLs this app answers to.
    ///
    /// `hermit://session/<id>` is built by the Live Activity and routed through
    /// the same bridge call as a notification tap, so a session opened from the
    /// Lock Screen and one opened from a banner take the identical path
    /// (including the hard navigation that Next's router needs — see
    /// lib/native-bridge.ts).
    ///
    /// `hermit://server` opens the address dialog. It is the way back in when
    /// the app is pointed at something that answers but is not a dashboard: the
    /// offline screen never appears, so its "Change server" button is out of
    /// reach. Carries no address of its own — see `presentOriginEditor`.
    ///
    /// `hermit://sessions` pushes the native session list. It is a URL and not
    /// the front door: the list's real home is the sidebar drawer, and until
    /// that drawer is native this is how the screen gets driven on a real phone
    /// without also owning cold start.
    ///
    /// `hermit://timeline/<id>` opens the NATIVE timeline for that session.
    /// A tapped row in the list goes there too as of round 10 — this URL is
    /// what lets a test open one session in particular, and what opens the
    /// screen from a cold start with no list in between.
    ///
    /// `hermit://session/<id>` above is deliberately NOT that: it is the Live
    /// Activity's and a notification's URL, and it still opens the page. See
    /// `SessionListViewController.didSelectItemAt`.
    private func open(_ url: URL) {
        guard url.scheme == "hermit" else { return }
        switch url.host {
        case "session":
            let id = url.lastPathComponent
            guard !id.isEmpty, id != "session" else { return }
            // The path shape the page already understands. No machine parameter:
            // the activity belongs to whichever workspace raised it, and the page
            // picks the session up from its own keyring.
            openPath("/chat?session=\(id)")
        case "server":
            // Unanimated on purpose: an alert presented in the middle of a push
            // transition is presented from a view controller that is still
            // moving, and UIKit answers that with a log line and no dialog.
            presentWeb(animated: false).presentOriginEditor()
        case "sessions":
            presentList(animated: true)
        case "timeline":
            let id = url.lastPathComponent
            guard !id.isEmpty, id != "timeline" else { return }
            presentTimeline(sessionId: id, animated: true)
        default:
            return
        }
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // Don't keep ducking other apps' audio (or holding the mic indicator) while
        // we're not on screen.
        web.releaseAudioSession()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        clearBadge()
    }
}

// MARK: - What the app delegate delivers into

extension SceneDelegate: AppShell {
    /// Straight to the bridge, with no change to what is on screen. A token is
    /// bookkeeping between the shell and the server; the page parks it until it
    /// has loaded and a key to register it against.
    func deliverPushToken(_ token: String, env: ApnsEnvironment) {
        web.deliverPushToken(token, env: env)
    }

    /// A path always means "show me this page", so it brings the page forward as
    /// well as navigating it. Delivering it to a web view buried under a native
    /// screen would leave the tapped notification opening something the user
    /// never sees.
    func openPath(_ path: String) {
        presentWeb(animated: true).openDeepLink(path)
    }
}

// MARK: - Back, without a navigation bar to put it in

extension SceneDelegate: UIGestureRecognizerDelegate {
    /// The edge swipe is how you get back off a native screen — and it must not
    /// run on the page.
    ///
    /// Two clauses, each for its own failure:
    ///
    /// **`count > 1`** because UIKit disables its own back gesture whenever the
    /// navigation bar is hidden, and the bar is hidden under the timeline's push
    /// transition and over the page. Answering for the root, where there is
    /// nothing to pop to, leaves the stack mid-transition with no destination.
    ///
    /// **not over the page** because on a phone the left ~28px is the dashboard's
    /// sidebar drawer (`components/sidebar/use-drawer-swipe.ts`), and that
    /// drawer is the same list this screen used to replace. The web is the root
    /// today, so `count > 1` already covers it; the clause is here because that
    /// has been true and then false and then true again in eight rounds, and
    /// each time the symptom was "the drawer stopped opening" rather than
    /// anything that errors. WebKit's own back/forward swipe is a separate
    /// gesture and is negotiated separately — `setNativeEdgeSwipe`
    /// (lib/native-bridge.ts) → `WebViewController`.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === nav?.interactivePopGestureRecognizer else { return true }
        guard let nav, nav.viewControllers.count > 1 else { return false }
        return !(nav.topViewController is WebViewController)
    }
}
