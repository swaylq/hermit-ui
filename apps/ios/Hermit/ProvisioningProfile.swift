import Foundation

/// Which APNs environment this build's device token belongs to.
///
/// This is NOT cosmetic: an Xcode-installed build gets a token the sandbox APNs
/// host accepts and the production host rejects with `BadDeviceToken`, and a
/// TestFlight build is the reverse. The server can't tell them apart, so the app
/// reports it at registration.
///
/// `#if DEBUG` is the usual shortcut and it is wrong — a Release build installed
/// from Xcode still carries the development entitlement. The authoritative answer
/// is `aps-environment` in the embedded provisioning profile, so read that.
enum ApnsEnvironment: String {
    case sandbox
    case production

    /// Resolved once from `embedded.mobileprovision`. Defaults to `.production`
    /// when there is no profile at all, because that is what a profile-less build
    /// actually is: Apple re-signs App Store and TestFlight installs and strips
    /// the profile out. The other profile-less case is the simulator, where remote
    /// push does not work either way, so it costs nothing to be wrong there.
    ///
    /// The first TestFlight build got this backwards — it reported `sandbox`, the
    /// server sent to the sandbox host, and APNs answered `BadDeviceToken`.
    static let current: ApnsEnvironment = resolve()

    private static func resolve() -> ApnsEnvironment {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let plist = extractPlist(from: data),
              let value = plist["aps-environment"] as? String
        else { return .production }
        return value == "production" ? .production : .sandbox
    }

    /// The profile is a CMS-signed blob with an XML plist in the middle. Rather
    /// than pull in Security framework decoding, locate the plist by its document
    /// markers and hand that slice to PropertyListSerialization.
    private static func extractPlist(from data: Data) -> [String: Any]? {
        guard let open = "<plist".data(using: .utf8),
              let close = "</plist>".data(using: .utf8),
              let start = data.range(of: open),
              let end = data.range(of: close, in: start.upperBound ..< data.endIndex)
        else { return nil }
        let slice = data[start.lowerBound ..< end.upperBound]
        let parsed = try? PropertyListSerialization.propertyList(from: slice, format: nil)
        // The signed profile's plist holds a nested `Entitlements` dict; older
        // tooling wrote the keys flat. Accept either.
        guard let dict = parsed as? [String: Any] else { return nil }
        if let entitlements = dict["Entitlements"] as? [String: Any] { return entitlements }
        return dict
    }
}
