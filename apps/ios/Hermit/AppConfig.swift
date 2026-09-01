import Foundation

/// Everything environment-specific in one place. Point `origin` at a local dev
/// server (e.g. http://192.168.2.x:4101) to test against a laptop build — note
/// that plain HTTP needs an ATS exception in Info.plist, and getUserMedia itself
/// requires a secure context, so voice input only works over HTTPS or localhost.
enum AppConfig {
    static let defaultOrigin = URL(string: "https://dash.swaylab.ai")!

    /// Where the shell points. Overridable at launch with
    /// `-hermitOrigin http://localhost:4102` (UserDefaults reads the argument
    /// domain for free), which is how smoke.sh drives a local dashboard build —
    /// the shipping app never passes it, so this is the production URL in every
    /// real launch. `http://localhost` needs the NSAllowsLocalNetworking exception
    /// in Info.plist; it is still a secure context, so getUserMedia keeps working.
    static let origin: URL = {
        if let raw = UserDefaults.standard.string(forKey: "hermitOrigin"),
           let url = URL(string: raw), url.host != nil {
            return url
        }
        return defaultOrigin
    }()

    static var host: String { origin.host ?? "" }

    /// Hosts of the OTHER dashboard deployments this device holds a key for.
    ///
    /// One installed app can drive several deployments (docs/multi-deployment-
    /// design.md): a keyring entry carries a `baseUrl`, and its uploads, links and
    /// share URLs live on that origin. The shell has no keyring — it deliberately
    /// holds no credentials — so the web layer tells it (`{type:'origins'}` in
    /// lib/native-bridge.ts). Without this, opening a picture that lives on the
    /// second deployment threw the user out to Safari, which is a different
    /// storage jar: the feature simply stopped at the app's edge.
    ///
    /// Main-thread only: written from the script-message handler, read from the
    /// navigation delegate, both of which WebKit calls on the main queue.
    private(set) static var knownHosts: Set<String> = []

    /// Replace the set. Anything unparseable is dropped rather than guessed at.
    static func setKnownHosts(_ origins: [String]) {
        knownHosts = Set(origins.compactMap { URL(string: $0)?.host?.lowercased() }.filter { !$0.isEmpty })
    }

    /// Is this URL part of a dashboard we know (open it in the web view) or
    /// somewhere else (hand it to Safari)?
    static func isInternal(_ url: URL) -> Bool {
        guard let h = url.host?.lowercased() else { return false }
        if belongs(h, to: host) { return true }
        return knownHosts.contains { belongs(h, to: $0) }
    }

    /// Subdomain-safe host match. `a.example.com` belongs to `example.com`;
    /// `evilexample.com` must not, which a naive `hasSuffix("example.com")` gets
    /// wrong — hence the explicit dot.
    private static func belongs(_ host: String, to base: String) -> Bool {
        let b = base.lowercased()
        guard !b.isEmpty else { return false }
        return host == b || host.hasSuffix("." + b)
    }
}
