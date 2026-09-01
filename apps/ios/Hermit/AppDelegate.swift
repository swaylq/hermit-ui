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
        // Deliberately NOT asking for permission here. At cold launch the user has
        // not entered a machine key yet, so the web layer has nothing to register
        // the token against — a "yes" is thrown away and a "no" is permanent and
        // only reversible in iOS Settings. The web side asks instead, the moment it
        // holds at least one key (lib/native-bridge.ts → `requestPush`).
        //
        // Someone who already said yes on an earlier launch is a different case:
        // re-registering is silent, and the token can change, so do it now.
        registerIfAlreadyAuthorized()
        return true
    }

    // MARK: - Notification permission, on the web layer's schedule

    /// Ask the OS, but only if it has never been asked. Reports the resulting
    /// status either way — the caller uses it to decide what to show.
    func requestPushAuthorization(_ done: @escaping (String, Bool) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else {
                // Already answered. Re-asking cannot show the prompt again, so the
                // honest move is to report the standing answer and let the page
                // point at iOS Settings.
                self.finish(settings.authorizationStatus, done)
                return
            }
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                if let error { NSLog("[hermit] notification auth failed: \(error)") }
                // Trust the callback's own answer. Re-reading settings right here
                // can still come back `.notDetermined` for a beat, which would put
                // the page back on "开启通知" immediately after a successful grant.
                self.finish(granted ? .authorized : .denied, done)
            }
        }
    }

    /// Read the standing answer without ever prompting.
    func readPushStatus(_ done: @escaping (String, Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                done(Self.label(settings.authorizationStatus),
                     UIApplication.shared.isRegisteredForRemoteNotifications)
            }
        }
    }

    private func registerIfAlreadyAuthorized() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                // Must happen on the main thread; the callback lands on a background one.
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            default:
                break
            }
        }
    }

    private func finish(_ status: UNAuthorizationStatus, _ done: @escaping (String, Bool) -> Void) {
        DispatchQueue.main.async {
            switch status {
            case .authorized, .provisional, .ephemeral:
                UIApplication.shared.registerForRemoteNotifications()
            default:
                break
            }
            done(Self.label(status), UIApplication.shared.isRegisteredForRemoteNotifications)
        }
    }

    private static func label(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
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
