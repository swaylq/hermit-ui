import UIKit

/// What the app is: a navigation stack whose ROOT is the native session list,
/// with the web app pushed on top of it whenever a page is what's wanted.
///
/// ## The list is the front door (M3)
///
/// It shipped behind `hermit://sessions` first, pushed in front of the page, so
/// it could be driven on a real phone without also owning cold start. It owns
/// cold start now, and with it the offline case, every deep link and
/// `AppDelegate`'s push callbacks — which is why that URL and the three delivery
/// paths below all funnel into one method, `presentWeb`.
///
/// ## Except when nobody is signed in
///
/// With an empty keyring the list has nothing to draw and no way to fix that:
/// the sign-in gate is a web page, and so is the "change server" screen you need
/// when the address answers nothing. So a launch with no keyring entry pushes
/// the web layer immediately and unanimated, and the first thing on screen is
/// still the gate — the same rule the dashboard's own root applies.
///
/// ## The web view is built at launch either way
///
/// Even when it stays off screen. `WebViewController.viewDidLoad` is what
/// creates the WKWebView and starts the load, so building it here and calling
/// `loadViewIfNeeded()` means the dashboard is already fetched and parsed by the
/// time a row is tapped, instead of starting from nothing at that moment. It
/// also gives `AppDelegate` somewhere to deliver a push token that arrives
/// during launch. (Rendering is a different thing and does not start until it is
/// on screen; the pre-warm buys the network and the JavaScript, not the pixels.)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// The web layer. **One instance for the life of the scene, owned here** and
    /// only lent to the navigation stack.
    ///
    /// Held strongly rather than left to the stack because it comes back OFF the
    /// stack every time you go back to the list, and a stack is the only thing
    /// retaining what is in it: the WKWebView, the loaded document, the scroll
    /// position and every open connection would be deallocated on the way back,
    /// so the next tapped row would reload the whole dashboard. It goes the
    /// other way too — two instances would each hold their own web view, their
    /// own bridge and their own idea of which page is loaded.
    ///
    /// Built lazily, and `willConnectTo` builds it immediately. See the type
    /// comment for why it starts loading before anyone can see it.
    private lazy var web: WebViewController = {
        let made = WebViewController()
        made.loadViewIfNeeded()
        return made
    }()

    private var nav: UINavigationController? { window?.rootViewController as? UINavigationController }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let list = SessionListViewController()
        // The list does not go looking for a web view; it says where it wants to
        // go and this decides what that means. See `openPath` there.
        list.openPath = { [weak self] path in self?.openPath(path) }
        let nav = UINavigationController(rootViewController: list)
        // Hidden to start with. The list turns it on for itself in
        // `viewWillAppear` and back off on the way out, so a launch that goes
        // straight to the page never flashes a bar the page then hides.
        nav.isNavigationBarHidden = true
        // With the bar hidden UIKit stops running the back swipe, and the page
        // draws its own header so the bar stays hidden on top of it — which
        // would leave the web screen with no way back to the list at all. See
        // `gestureRecognizerShouldBegin`.
        nav.interactivePopGestureRecognizer?.delegate = self

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = nav
        window.makeKeyAndVisible()
        self.window = window

        // Off screen, but loading. This is also what APNs callbacks — which may
        // already have fired during launch — get delivered to.
        web.loadViewIfNeeded()
        (UIApplication.shared.delegate as? AppDelegate)?.attach(self)

        // Nothing to list and nowhere to sign in but the page.
        if KeyStore.active() == nil { presentWeb(animated: false) }

        // A tap on the Live Activity that launched us cold. The URL arrives here
        // rather than through `scene(_:openURLContexts:)`, which is only called
        // for a scene that already exists.
        if let url = connectionOptions.urlContexts.first?.url { open(url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url { open(url) }
    }

    // MARK: - The two screens

    /// Put the page on top, wherever it was. Idempotent: a second deep link
    /// arriving while the page is already up moves nothing.
    @discardableResult
    private func presentWeb(animated: Bool) -> WebViewController {
        guard let nav else { return web }
        if !nav.viewControllers.contains(web) {
            nav.pushViewController(web, animated: animated)
        } else if nav.topViewController !== web {
            nav.popToViewController(web, animated: animated)
        }
        return web
    }

    /// Show the session list, whatever is in front of it.
    private func presentList(animated: Bool) {
        nav?.popToRootViewController(animated: animated)
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
    /// `hermit://sessions` shows the list. It used to push it in front of the
    /// page; now that the list is the root it pops back to it, which is the same
    /// sentence — "show me the sessions" — and the reason the URL stays.
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
    /// well as navigating it. Delivering it to a web view sitting off screen —
    /// which is what happened when the page was the root and nobody had to think
    /// about it — would leave the tapped notification opening a screen the user
    /// never sees.
    func openPath(_ path: String) {
        presentWeb(animated: true).openDeepLink(path)
    }
}

// MARK: - Back, without a navigation bar to put it in

extension SceneDelegate: UIGestureRecognizerDelegate {
    /// The edge swipe is the whole way back from the page to the list.
    ///
    /// UIKit disables its own back gesture whenever the navigation bar is
    /// hidden, and the bar is hidden over the web view because the page draws
    /// its own header — so without this, the front door is a one-way door.
    /// Answering for the root (where there is nothing to pop to) would leave the
    /// stack mid-transition with no destination, hence the count.
    ///
    /// This does take the left edge away from the PAGE's own horizontal
    /// gestures, which on a phone is the drawer that opens the web sidebar. That
    /// sidebar is the list this screen replaced, so the two are the same
    /// intention and the native one should win; `setNativeEdgeSwipe`
    /// (lib/native-bridge.ts) is where that gets negotiated if it should not.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === nav?.interactivePopGestureRecognizer else { return true }
        return (nav?.viewControllers.count ?? 0) > 1
    }
}
