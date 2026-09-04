import Foundation

/// One entry in the web app's keyring, as it is serialized into the Keychain.
///
/// The shape is `KeyringEntry` in `apps/dashboard/src/lib/keyring.ts` and the
/// bytes are that file's `JSON.stringify(list)` — the shell stores the string it
/// is handed and, until now, never looked inside it.
///
/// Only the fields a native screen needs are declared. `Decodable` ignores the
/// rest, which is the behaviour we want here: the web adds a field to this type
/// far more often than it changes one, and a shell that refused to parse a
/// keyring because it grew a `lastUsedAt` would sign the user out of their own
/// app on an unrelated deploy.
struct KeyringEntry: Decodable, Equatable {
    /// The machine id (or the share token's id for a scoped entry).
    let id: String
    /// What the user named it. Shown when more than one is present.
    let name: String
    /// The bearer token — `x-asst-key` on every request made with this entry.
    let key: String
    /// Set on an AGENT SHARE entry, whose `key` is a `shr_…` token that can see
    /// exactly one agent. The server is the real boundary; this is only what
    /// lets a screen say so.
    let scoped: Bool?
    let agentName: String?
    /// The dashboard deployment this entry lives on, when it is not the one the
    /// shell is pointed at. Empty or absent means "this origin", which is what
    /// every entry meant before multi-deployment support — see
    /// `apps/dashboard/src/lib/api-base.ts`.
    let baseUrl: String?
}

/// Which machine key a native request should carry.
///
/// **This is where the shell starts USING a credential**, not just storing one.
/// Everything before it — `Keychain`, `HermitAPI`, `HermitStream` — was built so
/// that the reading and the choosing happened in exactly one auditable place;
/// this is that place, and it is the only file in the app that turns a stored
/// keyring into a token on a request. `README.md` says so too.
///
/// ## Why this is not just `list[0]`
///
/// The keyring LIST is in the Keychain, but which entry is ACTIVE was, on the
/// web, in `sessionStorage` — inside the web view, where nothing native can see
/// it. So a shell reading `list[0]` would quietly send a different machine's key
/// than the page two millimetres above it: the user switches machine in the web
/// app, the native list keeps showing the old one, and nothing anywhere says
/// why.
///
/// The page therefore tells us: `keychain.setActive` (WebViewController's method
/// table) writes the id here whenever `setActiveMachine` runs on that side. The
/// fallback when it has never run — a keyring written by an older shell, or a
/// launch before the page has loaded — is `list[0]`, which is *precisely* what
/// `getActiveEntry()` falls back to on the web, so the two agree by construction
/// rather than by luck.
enum KeyStore {
    /// The Keychain account holding the id of the active entry.
    ///
    /// A `#` cannot appear in a bare origin (no fragment, no path), so this
    /// cannot collide with the keyring account itself, which IS the origin.
    static func activeAccount(_ origin: URL) -> String { origin.absoluteString + "#active" }

    /// The serialized keyring for an origin, decoded. Empty when there is none,
    /// when the Keychain refused, or when the stored bytes are not a keyring —
    /// a caller can do nothing different with those three, and each already logs.
    static func keyring(origin: URL = AppConfig.origin) -> [KeyringEntry] {
        let got = Keychain.read(account: origin.absoluteString)
        guard let raw = got.value, let data = raw.data(using: .utf8) else { return [] }
        do {
            return try JSONDecoder().decode([KeyringEntry].self, from: data)
        } catch {
            NSLog("[hermit] the stored keyring did not decode: \(error)")
            return []
        }
    }

    /// The id the page last made active, if it has ever said.
    static func activeId(origin: URL = AppConfig.origin) -> String? {
        let got = Keychain.read(account: activeAccount(origin))
        guard let v = got.value, !v.isEmpty else { return nil }
        return v
    }

    /// The entry a request should be made with, or nil when the user has not
    /// signed in on this origin at all.
    static func active(origin: URL = AppConfig.origin) -> KeyringEntry? {
        let list = keyring(origin: origin)
        if list.isEmpty { return nil }
        if let id = activeId(origin: origin), let hit = list.first(where: { $0.id == id }) {
            return hit
        }
        return list.first
    }

    /// Remember the page's pick. Empty id clears it — "no entry is active" is a
    /// state the web reaches by signing out of the last machine.
    @discardableResult
    static func setActiveId(_ id: String, origin: URL = AppConfig.origin) -> OSStatus {
        id.isEmpty
            ? Keychain.delete(account: activeAccount(origin))
            : Keychain.write(id, account: activeAccount(origin))
    }

    /// Forget both halves. Called by `keychain.clear`, which on the web is
    /// "signed out of the last machine" — leaving the active id behind would
    /// leave a pointer to an entry that no longer exists.
    @discardableResult
    static func clear(origin: URL = AppConfig.origin) -> OSStatus {
        let a = Keychain.delete(account: origin.absoluteString)
        let b = Keychain.delete(account: activeAccount(origin))
        return a == errSecSuccess ? b : a
    }

    /// Where an entry's requests go: its own deployment if it names one, else
    /// the origin the shell is pointed at. Same rule as `apiBase()` on the web.
    static func base(for entry: KeyringEntry, origin: URL = AppConfig.origin) -> URL {
        guard let raw = entry.baseUrl, !raw.isEmpty, let u = URL(string: raw), u.host != nil else {
            return origin
        }
        return u
    }
}
