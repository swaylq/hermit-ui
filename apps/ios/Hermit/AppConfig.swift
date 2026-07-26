import Foundation

/// Everything environment-specific in one place. Point `origin` at a local dev
/// server (e.g. http://192.168.2.x:4101) to test against a laptop build — note
/// that plain HTTP needs an ATS exception in Info.plist, and getUserMedia itself
/// requires a secure context, so voice input only works over HTTPS or localhost.
enum AppConfig {
    static let origin = URL(string: "https://dash.swaylab.ai")!

    static var host: String { origin.host ?? "" }

    /// Is this URL part of the dashboard (open it in the web view) or somewhere
    /// else (hand it to Safari)? Subdomain-safe: `a.example.com` must not match
    /// a naive `hasSuffix("example.com")` against `evilexample.com`.
    static func isInternal(_ url: URL) -> Bool {
        guard let h = url.host?.lowercased() else { return false }
        return h == host || h.hasSuffix("." + host)
    }
}
