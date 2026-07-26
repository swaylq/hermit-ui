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
