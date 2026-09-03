import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let controller = WebViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = controller
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

    /// `hermit://session/<id>` — the only URL this app answers to, built by the
    /// Live Activity and consumed here. Routed through the same bridge call as a
    /// notification tap, so a session opened from the Lock Screen and one opened
    /// from a banner take the identical path (including the hard navigation that
    /// Next's router needs — see lib/native-bridge.ts).
    private func open(_ url: URL) {
        guard url.scheme == "hermit", url.host == "session" else { return }
        let id = url.lastPathComponent
        guard !id.isEmpty, id != "session" else { return }
        guard let controller = window?.rootViewController as? WebViewController else { return }
        // The path shape the page already understands. No machine parameter: the
        // activity belongs to whichever workspace raised it, and the page picks
        // the session up from its own keyring.
        controller.openDeepLink("/chat?session=\(id)")
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // Don't keep ducking other apps' audio (or holding the mic indicator) while
        // we're not on screen.
        (window?.rootViewController as? WebViewController)?.releaseAudioSession()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        clearBadge()
    }
}
