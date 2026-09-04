import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // A navigation controller, not the web view itself, even though the web
        // view is still the only thing in it.
        //
        // M3 puts native screens in front of the page — a session list, then the
        // timeline — and those are pushes, not modals: the back swipe, the title
        // and the animation all come with the container and none of them are
        // worth hand-rolling. Making it the root NOW rather than with the first
        // native screen keeps that change to "insert a view controller", and
        // means anything that breaks in this rearrangement (a safe-area inset, a
        // status-bar style, a gesture) surfaces on its own instead of inside a
        // commit that also draws a new screen.
        //
        // The bar is hidden: the page draws its own header. A pushed native
        // screen turns it on for itself.
        let controller = WebViewController()
        let nav = UINavigationController(rootViewController: controller)
        nav.isNavigationBarHidden = true
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = nav
        window.makeKeyAndVisible()
        self.window = window

        // Hand the controller to the app delegate so APNs callbacks — which may
        // already have fired during launch — can reach the web layer.
        (UIApplication.shared.delegate as? AppDelegate)?.attach(controller)

        // A tap on the Live Activity that launched us cold. The URL arrives here
        // rather than through `scene(_:openURLContexts:)`, which is only called
        // for a scene that already exists.
        if let url = connectionOptions.urlContexts.first?.url { open(url) }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url { open(url) }
    }

    /// The web layer, found in the stack rather than assumed to be the root.
    ///
    /// It is the root today. It stops being the root the moment a native session
    /// list goes under it, and the three call sites that used to reach for
    /// `rootViewController` would each have gone quietly wrong rather than
    /// crashed: a deep link that opens nothing, a Live Activity tap that lands
    /// on the wrong screen, an audio session held after the app leaves the
    /// foreground (the microphone indicator stays lit). Searching the stack
    /// costs nothing per call and cannot rot the same way.
    private var web: WebViewController? {
        guard let nav = window?.rootViewController as? UINavigationController else {
            return window?.rootViewController as? WebViewController
        }
        return nav.viewControllers.lazy.compactMap({ $0 as? WebViewController }).first
    }

    /// The two `hermit://` URLs this app answers to.
    ///
    /// `hermit://session/<id>` is built by the Live Activity and routed through the
    /// same bridge call as a notification tap, so a session opened from the Lock
    /// Screen and one opened from a banner take the identical path (including the
    /// hard navigation that Next's router needs — see lib/native-bridge.ts).
    ///
    /// `hermit://server` opens the address dialog. It is the way back in when the
    /// app is pointed at something that answers but is not a dashboard: the
    /// offline screen never appears, so its "Change server" button is out of
    /// reach. Carries no address of its own — see `presentOriginEditor`.
    private func open(_ url: URL) {
        guard url.scheme == "hermit" else { return }
        guard let controller = web else { return }
        switch url.host {
        case "session":
            let id = url.lastPathComponent
            guard !id.isEmpty, id != "session" else { return }
            // The path shape the page already understands. No machine parameter:
            // the activity belongs to whichever workspace raised it, and the page
            // picks the session up from its own keyring.
            controller.openDeepLink("/chat?session=\(id)")
        case "server":
            controller.presentOriginEditor()
        default:
            return
        }
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // Don't keep ducking other apps' audio (or holding the mic indicator) while
        // we're not on screen.
        web?.releaseAudioSession()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        clearBadge()
    }
}
