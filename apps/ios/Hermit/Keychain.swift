import Foundation
import Security

/// The one place this app stores a secret.
///
/// Until M1 the shell held nothing: the dashboard kept its machine keys in the
/// web view's localStorage and the native side never saw one. localStorage is a
/// plain SQLite file in the app container — readable from a file-level backup,
/// and readable while the phone is locked. The keys are bearer tokens for a whole
/// machine, so they belong somewhere the OS encrypts against the passcode. That is
/// this file; `WebViewController.answer()` is the only caller.
///
/// Three attributes carry the whole policy:
///
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — decryptable only after
///   the first unlock since boot (a background push at 4am still works, a lost
///   phone that never got unlocked does not), and `ThisDeviceOnly` keeps the item
///   out of encrypted backups and off any restored device.
/// - `kSecAttrSynchronizable: false` — never iCloud Keychain. A machine key is a
///   credential for one phone, not for the Apple ID.
/// - no access group — the app's own, which is the default. Sharing with the
///   widget extension would need a `keychain-access-groups` entitlement and a
///   provisioning profile carrying it, and nothing over there wants the keyring:
///   the Live Activity is drawn from what the server pushes into it.
///
/// Entries are keyed by ACCOUNT, and the caller passes the origin the web layer
/// is running on. Two deployments therefore never see each other's keys, which is
/// the same boundary localStorage gave for free and the reason a page can be
/// allowed to read this at all without a person in the loop.
enum Keychain {
    /// One service for everything this app stores; `account` is what separates
    /// entries. Not the bundle id — a rename of the app must not orphan the keys.
    static let service = "ai.swaylab.hermit.web"

    /// The stored string, plus the raw OSStatus.
    ///
    /// The status is carried out rather than swallowed because every way this can
    /// fail looks identical from the web side — "your key is gone" — and the
    /// number is the entire diagnosis (-34018 is a build with no entitlements,
    /// -25300 is simply nothing stored).
    static func read(account: String) -> (value: String?, status: OSStatus) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            if status != errSecItemNotFound { NSLog("[hermit] keychain read failed: \(status)") }
            return (nil, status)
        }
        return (String(data: data, encoding: .utf8), status)
    }

    /// Store (or replace) one string. `errSecSuccess` means it landed.
    ///
    /// Add-then-update rather than delete-then-add: a delete that succeeds and an
    /// add that fails would leave the user signed out of a shell that had their
    /// key a millisecond earlier.
    @discardableResult
    static func write(_ value: String, account: String) -> OSStatus {
        guard let data = value.data(using: .utf8) else { return errSecParam }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        let add = query.merging([
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]) { a, _ in a }

        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            // `kSecAttrAccessible` is settable on update too, so an item written
            // by an older build with weaker protection is upgraded in place here
            // rather than living on with it.
            status = SecItemUpdate(query as CFDictionary, [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ] as CFDictionary)
        }
        if status != errSecSuccess { NSLog("[hermit] keychain write failed: \(status)") }
        return status
    }

    /// Remove the entry. Nothing there already counts as success — the caller
    /// (sign-out) wants the end state, not the transition.
    @discardableResult
    static func delete(account: String) -> OSStatus {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ] as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            NSLog("[hermit] keychain delete failed: \(status)")
        }
        return status == errSecItemNotFound ? errSecSuccess : status
    }
}
