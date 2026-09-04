import Foundation

/// Everything environment-specific in one place.
enum AppConfig {
    /// The origin this build ships pointing at, and the fallback whenever nothing
    /// else resolves.
    static let defaultOrigin = URL(string: "https://dash.swaylab.ai")!

    // MARK: - Where the shell points

    /// The origin the USER chose, persisted. Written only by `setOrigin`, and only
    /// with a value `normalizeOrigin` has already accepted.
    ///
    /// This exists because `dash.swaylab.ai` is folding into `hermit`, and until
    /// today the address was a compile-time constant: an installed build could not
    /// follow the move, and the microphone check below is an EXACT host match, so
    /// the one feature this app was built for would have started denying silently
    /// (docs/ios-native-progress.md, M0).
    static let userOriginKey = "hermitOriginOverride"

    /// The developer override, passed as `-hermitOrigin https://…` — UserDefaults
    /// exposes the process arguments as a domain, so no parsing is needed. This is
    /// how `smoke.sh` drives a dashboard build running on the Mac.
    static let launchArgumentKey = "hermitOrigin"

    /// Where the shell points, highest precedence first:
    ///
    ///   1. `-hermitOrigin <url>` on the command line — developer only, and NOT
    ///      validated (see `launchArgumentOrigin`)
    ///   2. the address the user typed, under `userOriginKey`
    ///   3. `defaultOrigin`
    ///
    /// A stored value: read once at launch and again after `setOrigin` /
    /// `clearOrigin`, never on every access — `host` is read from WebKit callbacks
    /// on the hot path. Main-thread only, like `knownHosts`.
    private(set) static var origin: URL = resolveOrigin()

    static var host: String { origin.host ?? "" }

    /// The address the user set, or nil if they never did. Not the effective one —
    /// that is `origin`, which a launch argument can still outrank.
    static var userOrigin: URL? {
        guard let raw = UserDefaults.standard.string(forKey: userOriginKey) else { return nil }
        return try? normalizeOrigin(raw)
    }

    /// Point the shell at another deployment. Throws `OriginError` — whose message
    /// is meant to be shown as-is — when the address is not a bare http(s) origin.
    ///
    /// Everything the old origin loaded has to go: the page's tRPC client, its SSE
    /// reader and its WebSockets are all built once per document against one
    /// backend (apps/dashboard/src/lib/api-base.ts, "safe to read once per page
    /// load"). So the caller reloads the web view from scratch rather than
    /// navigating; a stored origin that only half took effect would be worse than
    /// none. `origin` is re-resolved rather than assigned, because a launch
    /// argument still outranks what was just stored.
    static func setOrigin(_ raw: String) throws {
        let url = try normalizeOrigin(raw)
        UserDefaults.standard.set(url.absoluteString, forKey: userOriginKey)
        origin = resolveOrigin()
    }

    /// Back to `defaultOrigin` (or to the launch argument, if there is one).
    static func clearOrigin() {
        UserDefaults.standard.removeObject(forKey: userOriginKey)
        origin = resolveOrigin()
    }

    /// Why an address was refused. The message is the user-facing one, worded
    /// exactly like the web layer's so the two can never disagree about the same
    /// typo.
    struct OriginError: LocalizedError, Equatable {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    /// Ports WebKit will not open, so neither will this app.
    ///
    /// Rejecting them here is not tidiness. WebKit refuses a blocked port by
    /// COMMITTING AN EMPTY DOCUMENT rather than by failing the navigation, so
    /// `didFailProvisionalNavigation` never fires, the offline screen never
    /// appears, and the user is left looking at white forever with no way back —
    /// `https://example.com:9` used to pass this function and do exactly that
    /// (observed on the simulator, docs/ios-native-progress.md).
    ///
    /// The list is the Fetch spec's "bad port" set, read out of a live
    /// implementation rather than transcribed: `fetch('http://127.0.0.1:<p>/')`
    /// over 1-11000 under Node 26, keeping the ports that fail with `bad port`
    /// instead of `ECONNREFUSED`. That is also why 105-108 and 112 are absent
    /// while their neighbours are there — the real list is not the tidy ranges
    /// it looks like. Keep it sorted; `apps/dashboard/src/lib/api-base.ts` holds
    /// the same 82 numbers and the same message.
    static let blockedPorts: Set<Int> = [
        1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
        79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
        135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526,
        530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
        995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
        6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    ]

    /// Normalize a typed backend address into `https://host[:port]`.
    ///
    /// Ported from `normalizeBase()` — apps/dashboard/src/lib/api-base.ts:28-44 —
    /// down to the error strings. A typo that quietly became a relative path, or
    /// plain http on a public host, would put the machine key on the wire to
    /// somewhere else.
    ///
    /// One deliberate difference: `''` is refused here. On the web it means "this
    /// origin", which a shell has no equivalent of; `clearOrigin()` is that.
    static func normalizeOrigin(_ raw: String) throws -> URL {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { throw OriginError("backend address is empty") }

        // Same order as the web: assume https for a bare host, and only THEN parse.
        // Parsing first would read `dash.swaylab.ai:8080` as scheme + path.
        let hasScheme = s.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
        let withScheme = hasScheme ? s : "https://" + s

        guard let c = URLComponents(string: withScheme),
              let rawHost = c.host, !rawHost.isEmpty else {
            throw OriginError("backend address is not a URL")
        }
        let scheme = (c.scheme ?? "").lowercased()
        guard scheme == "https" || scheme == "http" else {
            throw OriginError("backend address must be http(s)")
        }

        // Foundation hands back an IPv6 literal without its brackets; both the
        // loopback test and the rebuilt URL need them.
        let bare = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if scheme == "http", !["localhost", "127.0.0.1", "::1"].contains(bare) {
            throw OriginError("backend address must be https (http is only allowed for localhost)")
        }
        guard c.path.isEmpty || c.path == "/", c.query == nil, c.fragment == nil else {
            throw OriginError("backend address must be a bare origin, no path")
        }
        if let port = c.port, !(1...65535).contains(port) {
            throw OriginError("backend address is not a URL")
        }
        if let port = c.port, blockedPorts.contains(port) {
            throw OriginError("backend address port \(port) is blocked (browsers refuse to open it)")
        }

        // Rebuilt rather than returned: this drops any `user:pass@` (the classic
        // `https://dash.swaylab.ai@evil.example` disguise) and the redundant
        // default port, so two spellings of one deployment cannot produce two
        // different `host` values.
        let host = bare.contains(":") ? "[\(bare)]" : bare
        var out = "\(scheme)://\(host)"
        if let port = c.port, port != (scheme == "https" ? 443 : 80) { out += ":\(port)" }
        guard let url = URL(string: out) else { throw OriginError("backend address is not a URL") }
        return url
    }

    private static func resolveOrigin() -> URL {
        if let url = launchArgumentOrigin() { return url }
        if let url = userOrigin { return url }
        return defaultOrigin
    }

    /// `-hermitOrigin http://192.168.2.10:4101`, read from the ARGUMENT domain and
    /// nowhere else.
    ///
    /// Deliberately not run through `normalizeOrigin`, on two counts, and the
    /// argument domain is read explicitly so that neither relaxation can ever apply
    /// to a value a user typed:
    ///
    ///   - plain http to a LAN address is the documented way to test against a
    ///     laptop build (README.md, "Pointing the shell at a dev server");
    ///   - `SmokeTests.launch(path:)` appends a ROUTE to it (`…:4102/push`) to open
    ///     a screen directly, which `normalizeOrigin` refuses by design.
    private static func launchArgumentOrigin() -> URL? {
        let domain = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
        guard let raw = domain[launchArgumentKey] as? String,
              let url = URL(string: raw), url.host != nil else { return nil }
        return url
    }

    // MARK: - Other deployments this device holds a key for

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
