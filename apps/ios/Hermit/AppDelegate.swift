import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    /// Set by SceneDelegate once the UI exists, so push callbacks — which can fire
    /// before or after that — always have somewhere to deliver to.
    weak var webController: WebViewController?

    /// Parked until a controller exists (a notification tap can launch the app cold).
    private var pendingToken: (String, ApnsEnvironment)?
    private var pendingPath: String?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error { NSLog("[hermit] notification auth failed: \(error)") }
            guard granted else { return }
            // Must happen on the main thread; the callback lands on a background one.
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    // MARK: - APNs registration

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        // The environment comes from the embedded provisioning profile, not a
        // build flag — see ProvisioningProfile.swift for why that distinction bites.
        deliver(token: hex, env: ApnsEnvironment.current)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Expected on the simulator, which has no APNs at all.
        NSLog("[hermit] APNs registration failed: \(error.localizedDescription)")
    }

    // MARK: - Delivery to the web layer

    func attach(_ controller: WebViewController) {
        webController = controller
        if let (token, env) = pendingToken {
            pendingToken = nil
            controller.deliverPushToken(token, env: env)
        }
        if let path = pendingPath {
            pendingPath = nil
            controller.openDeepLink(path)
        }
    }

    private func deliver(token: String, env: ApnsEnvironment) {
        if let c = webController { c.deliverPushToken(token, env: env) } else { pendingToken = (token, env) }
    }

    private func deliver(path: String) {
        if let c = webController { c.openDeepLink(path) } else { pendingPath = path }
    }
}

/// Reset the app-icon badge. Free function so both the app delegate and the scene
/// delegate can call it without one depending on the other.
func clearBadge() {
    UNUserNotificationCenter.current().setBadgeCount(0)
}

// MARK: - UNUserNotificationCenterDelegate

extension AppDelegate: UNUserNotificationCenterDelegate {
    /// Foreground notifications are still shown. The server already drops pushes
    /// for a session you're actively reading (the `viewing` suppression rule), so
    /// what reaches here while the app is open is about some OTHER agent — worth
    /// seeing.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        // `path` is set by the server alongside the alert (server/push/events.ts).
        if let path = response.notification.request.content.userInfo["path"] as? String {
            deliver(path: path)
        }
        clearBadge()
        completionHandler()
    }
}
