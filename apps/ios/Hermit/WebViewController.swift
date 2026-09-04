import AVFoundation
import SafariServices
import UIKit
import WebKit

/// The whole app: one full-screen web view pointed at the dashboard, plus the
/// handful of native behaviours a web page can't do for itself.
final class WebViewController: UIViewController {
    private var webView: WKWebView!
    private let bridge = NativeBridge()
    private lazy var offlineView = OfflineView(
        onRetry: { [weak self] in self?.reload() },
        onChangeServer: { [weak self] in self?.presentOriginEditor() }
    )
    /// The "switch server?" alert, while one is on screen.
    ///
    /// Held only to refuse a second: `setOrigin` is reachable from the page, and
    /// a page calling it in a loop would stack modals faster than a person can
    /// dismiss them, with the app unreachable underneath.
    private weak var originConfirmation: UIAlertController?

    // MARK: - Setup

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .appBackground
        buildWebView()
        load()
        NotificationCenter.default.addObserver(
            self, selector: #selector(didEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil
        )
    }

    private func buildWebView() {
        let config = WKWebViewConfiguration()
        // Persistent store: the dashboard's session state, caches and the
        // per-tab active machine live here across launches. The machine KEYS moved
        // out to the Keychain in M1 (Keychain.swift) — this store is an
        // unencrypted SQLite file in the app container, which is fine for
        // everything still in it and was not fine for bearer tokens.
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(bridge, name: NativeBridge.handlerName)
        config.userContentController.addUserScript(Self.shellMarkerScript)

        // The web layer decides WHEN to ask for notification permission, because
        // only it knows whether there is a machine key to register a token
        // against. See AppDelegate for why asking at launch was wrong.
        bridge.onRequestPush = { done in Self.appDelegate?.requestPushAuthorization(done) }
        bridge.onReadPushStatus = { done in Self.appDelegate?.readPushStatus(done) }
        // The web layer knows exactly when a microphone stream is open; the
        // permission callback does not (WebKit skips it while it still holds a
        // grant). See `activateRecordingSession`.
        bridge.onMicActive = { [weak self] active in
            if active { self?.activateRecordingSession() } else { self?.releaseAudioSession() }
        }
        // WebKit has no haptics API on iOS, so the page cannot buzz on its own.
        bridge.onHaptic = { style in Haptics.play(style) }
        // Whether our edge swipe may run. See `allowsBackForwardNavigationGestures` below.
        bridge.onEdgeSwipe = { [weak self] enabled in
            self?.webView.allowsBackForwardNavigationGestures = enabled
        }
        // Lock Screen / Dynamic Island. The page drives the lifecycle because
        // only it knows when a turn starts; the SERVER drives the updates after
        // that, through the token handed back here. See LiveActivityManager.
        bridge.onLiveActivity = { [weak self] cmd in self?.applyLiveActivity(cmd) }
        bridge.onLiveActivityStatus = { [weak self] in
            let s = LiveActivityManager.status()
            self?.bridge.sendLiveActivityStatus(supported: s.supported, enabled: s.enabled)
        }
        // Questions, as opposed to every announcement above. `answer` holds the
        // entire list of what a page may ask the shell to do, in one switch, so
        // that list stays something you can read in one sitting.
        bridge.onRequest = { [weak self] method, params, reply in
            guard let self else {
                // Nothing left to answer with. Saying so beats letting the page
                // sit out its whole five-second timeout.
                reply(false, ["error": "the shell is going away"])
                return
            }
            self.answer(method, params: params, reply: reply)
        }
        // The app-wide token, watched from launch. It is reissued on the
        // system's own schedule, so starting to listen only once something wants
        // it would mean waiting an unknown time for the next one.
        LiveActivityManager.observePushToStartToken { [weak self] token in
            self?.bridge.sendLiveActivityToken(kind: "start", token: token, sessionId: "", sinceMs: 0)
        }

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        // Off until the page asks for it, and the page only asks where it has no
        // horizontal gesture of its own.
        //
        // The dashboard's mobile sidebar is a drawer you pull from the left ~28px
        // (app-sidebar.tsx), which is exactly where WebKit puts its own back
        // swipe. That one is a UIKit gesture recogniser living outside the web
        // content, so it claims the touch before any JS runs: the drawer's
        // `preventDefault()` cannot reach it, and on a phone the pull read as
        // "go back" instead of opening the sidebar. The page cannot win this from
        // its side, so the shell yields from ours.
        //
        // Default off rather than on because the two failures are not
        // symmetrical: on costs the drawer, which is a navigation surface with no
        // other gesture; off costs a swipe-back that every screen also offers as a
        // button. A dashboard too old to send `edgeSwipe` therefore lands on the
        // harmless side.
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .appBackground
        webView.scrollView.backgroundColor = .appBackground
        // The page owns its own safe-area insets (viewport-fit=cover +
        // env(safe-area-inset-*)); letting UIKit add its own would double them.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Cleaner than the page's gesturestart/preventDefault workaround, which
        // only exists because Safari ignores user-scalable=no.
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        bridge.attach(to: webView)

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private static var appDelegate: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

    /// Tell the page, before its first paint, that it is inside the shell.
    ///
    /// The dashboard's iOS adaptations — safe-area padding, the measured
    /// `--app-h` that keeps the composer above the keyboard, the ⌘-shortcuts —
    /// were all written for an installed PWA and gated on
    /// `@media (display-mode: standalone)`. A WKWebView reports `browser`, so
    /// inside this app every one of them was switched off: headers under the
    /// notch, the keyboard over the composer. A class on `<html>` is the cheapest
    /// thing CSS can key off, and it has to be set at document start or the first
    /// frame paints without it. (`<html suppressHydrationWarning>` in layout.tsx
    /// means React will not fight over the attribute.)
    private static let shellMarkerScript = WKUserScript(
        source: """
        (function () {
          var mark = function () {
            if (document.documentElement) {
              document.documentElement.classList.add('native-shell');
              return true;
            }
            return false;
          };
          if (!mark()) {
            document.addEventListener('readystatechange', mark, { once: true });
          }
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    private func load() {
        webView.load(URLRequest(url: AppConfig.origin))
    }

    private func reload() {
        offlineView.hide()
        if webView.url == nil { load() } else { webView.reload() }
    }

    // MARK: - What the page may ask the shell to do

    /// Answer one `{type:'req'}` from the page — the other half of
    /// `nativeRequest()` in lib/native-bridge.ts.
    ///
    /// Everything reachable from here is deliberately small and deliberately
    /// listed in one place. The web layer runs code the shell did not write and
    /// cannot audit, so "what can a page make this app do" has to be a list, not
    /// an emergent property of a dozen closures.
    ///
    /// `reply` runs exactly once per call, on the main queue. A method that
    /// waits on a person (`setOrigin` does) answers late rather than twice; the
    /// bridge drops everything after the first answer regardless.
    private func answer(_ method: String, params: [String: Any], reply: @escaping (Bool, Any?) -> Void) {
        switch method {
        case "getOrigin":
            // Not `location.origin`, which the page already knows. What it
            // cannot see is which of the three sources that address came from —
            // enough to render "Server: dash.swaylab.ai (default)" honestly.
            reply(true, [
                "origin": AppConfig.origin.absoluteString,
                "defaultOrigin": AppConfig.defaultOrigin.absoluteString,
                "isUserSet": AppConfig.userOrigin != nil,
            ])
        case "setOrigin":
            proposeOrigin(params["origin"] as? String ?? "", reply: reply)
        case "keychain.get":
            guard let account = keychainAccount(reply) else { return }
            // NSNull, not a missing field: "there is nothing stored" is an answer
            // the page acts on (it migrates its localStorage copy in), and an
            // absent key would be indistinguishable from an older shell.
            let got = Keychain.read(account: account)
            guard got.value != nil || got.status == errSecItemNotFound else {
                reply(false, ["error": "the keychain would not open (\(got.status))"])
                return
            }
            let value: Any = got.value ?? NSNull()
            reply(true, ["value": value])
        case "keychain.set":
            guard let account = keychainAccount(reply) else { return }
            guard let value = params["value"] as? String else {
                reply(false, ["error": "keychain.set needs a string value"])
                return
            }
            // A keyring is a few hundred bytes. The cap is not about the keychain
            // coping — it is that a page looping on this must not be able to grow
            // an item the user can only clear by deleting the app.
            guard value.utf8.count <= 64 * 1024 else {
                reply(false, ["error": "keychain value is too large"])
                return
            }
            let stored = Keychain.write(value, account: account)
            reply(stored == errSecSuccess,
                  stored == errSecSuccess ? nil : ["error": "the keychain refused the write (\(stored))"])
        case "keychain.clear":
            guard let account = keychainAccount(reply) else { return }
            let cleared = Keychain.delete(account: account)
            reply(cleared == errSecSuccess,
                  cleared == errSecSuccess ? nil : ["error": "the keychain refused the delete (\(cleared))"])
        default:
            // Same wording the bridge uses when there is no handler at all, so a
            // page cannot tell "this shell is too old for that method" from
            // "this shell has no method table" — there is nothing useful it
            // would do differently.
            reply(false, ["error": "unknown method: \(method)"])
        }
    }

    /// Which keychain entry the page in front of us is allowed to touch, or nil
    /// after answering the refusal itself.
    ///
    /// `setOrigin` can lean on a person tapping Confirm. This cannot: a read
    /// happens on every page load, and a system dialog on every page load is a
    /// dialog nobody reads. So the gate is structural, and it is the same one the
    /// microphone uses — an EXACT match against the address the shell was pointed
    /// at, not `isInternal`. `isInternal` also accepts `knownHosts`, which the
    /// PAGE supplies, and the main frame is allowed to navigate to those: without
    /// this check a dashboard that reported an attacker's host could then send the
    /// main frame there and read the keyring back out of the keychain.
    ///
    /// The account is the origin, so each deployment gets its own entry — the same
    /// separation localStorage gave for free, kept rather than quietly widened.
    private func keychainAccount(_ reply: (Bool, Any?) -> Void) -> String? {
        // Ports compared with the scheme default filled in: `URL.port` is nil for
        // an address that simply omitted it, so `https://x` and `https://x:443`
        // are the same origin and must not read as two.
        func port(_ u: URL) -> Int? { u.port ?? (u.scheme == "https" ? 443 : u.scheme == "http" ? 80 : nil) }
        let here = webView.url
        guard let here,
              here.scheme == AppConfig.origin.scheme,
              here.host == AppConfig.origin.host,
              port(here) == port(AppConfig.origin)
        else {
            reply(false, ["error": "the keychain is only readable from the shell's own origin"])
            return nil
        }
        return AppConfig.origin.absoluteString
    }

    // MARK: - Which deployment this shell points at

    /// Ask for a backend address and, if one is accepted, start over against it.
    ///
    /// Reachable from two places, and both have to work when the current address
    /// resolves to nothing at all: the offline screen's "Change server" button,
    /// and `hermit://server` (SceneDelegate). The second exists because the first
    /// only appears when the document FAILS to load — an address that answers but
    /// isn't a dashboard would otherwise leave no way back, and until M1 puts a
    /// control inside the page there is no third door.
    ///
    /// The URL only opens this dialog; it carries no address of its own. Any app
    /// or web page can open a URL scheme, and none of them may point this shell
    /// somewhere the user did not type.
    func presentOriginEditor(prefill: String? = nil) {
        let alert = UIAlertController(
            title: "Server address",
            message: "Where this app looks for Hermit.",
            preferredStyle: .alert
        )
        // Held rather than read back off the alert inside the handler: capturing
        // the controller in its own action's closure is a retain cycle, and a
        // text field does not own the alert.
        var input: UITextField?
        alert.addTextField { field in
            field.text = prefill ?? AppConfig.origin.absoluteString
            field.placeholder = AppConfig.defaultOrigin.absoluteString
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.clearButtonMode = .whileEditing
            input = field
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        // Only when there is something to undo. With no address stored this
        // button would do exactly what Cancel does.
        if AppConfig.userOrigin != nil {
            alert.addAction(UIAlertAction(title: "Use default", style: .default) { [weak self] _ in
                AppConfig.clearOrigin()
                self?.switchOrigin()
            })
        }
        let connect = UIAlertAction(title: "Connect", style: .default) { [weak self] _ in
            let typed = input?.text ?? ""
            do {
                try AppConfig.setOrigin(typed)
                self?.switchOrigin()
            } catch {
                self?.reportOriginError(error, retypeFrom: typed)
            }
        }
        alert.addAction(connect)
        // So the keyboard's return key submits instead of doing nothing.
        alert.preferredAction = connect
        presentOnTop(alert)
    }

    /// `OriginError.message` is already the user-facing sentence — worded exactly
    /// like the web layer's, so the two can never disagree about the same typo —
    /// and is shown as-is rather than rephrased here.
    ///
    /// What they typed comes back with them: having to retype a whole address on a
    /// phone to fix one character is its own reason to give up.
    private func reportOriginError(_ error: Error, retypeFrom typed: String) {
        let message = (error as? AppConfig.OriginError)?.message ?? error.localizedDescription
        let alert = UIAlertController(
            title: "Can't use that address", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            // Next runloop: this fires while the first alert is still unwinding,
            // and presenting into that leaves the second one on the floor with
            // only a console line to say so.
            DispatchQueue.main.async { self?.presentOriginEditor(prefill: typed) }
        })
        presentOnTop(alert)
    }

    /// Load `AppConfig.origin` from scratch.
    ///
    /// Not `webView.reload()`: a reload repeats the address of the document that
    /// is already loaded, which is the one thing changing here. Not a navigation
    /// either — the page builds its tRPC client, its SSE reader and its WebSockets
    /// once per document against one backend (apps/dashboard/src/lib/api-base.ts),
    /// so anything short of a fresh load would leave half of them pointed at the
    /// old deployment.
    ///
    /// The new origin is a different localStorage jar, so this lands on the
    /// sign-in gate. That is correct: the key belongs to the deployment it was
    /// issued by, and moving it is not this milestone's job.
    private func switchOrigin() {
        offlineView.hide()
        bridge.pageWillReload()
        // Reported by the PREVIOUS page, about deployments its keyring knew. This
        // set decides which links stay inside the app; nothing on the incoming
        // origin has vouched for them, so it starts empty and is refilled by the
        // new page's `origins` message.
        AppConfig.setKnownHosts([])
        // The Lock Screen activities belong to the deployment being left: its
        // server holds the push tokens that keep them current, and the incoming
        // page has no way to learn they exist, let alone end them.
        LiveActivityManager.endAll()
        webView.load(URLRequest(url: AppConfig.origin))
    }

    /// The page PROPOSES an address; the person holding the phone applies it.
    ///
    /// Not a silent `AppConfig.setOrigin`, and the reason is the microphone.
    /// Capture is granted on an exact `origin.host == AppConfig.host` match
    /// (`requestMediaCapturePermissionFor`, below), so wherever this shell is
    /// pointed gets the microphone with no prompt, on every launch, until
    /// someone changes it back. If one cross-site script on the dashboard could
    /// write that value, the shell would be handing an attacker a permanent
    /// silent microphone — strictly worse than the same script in Safari, which
    /// inverts the reason this app exists at all.
    ///
    /// With a confirmation in the way, the worst a compromised page can do is
    /// raise an alert naming the host it wants you to move to. That is a
    /// question a person can answer.
    private func proposeOrigin(_ raw: String, reply: @escaping (Bool, Any?) -> Void) {
        guard originConfirmation == nil else {
            reply(false, ["error": "a server switch is already waiting to be confirmed"])
            return
        }
        let url: URL
        do {
            url = try AppConfig.normalizeOrigin(raw)
        } catch {
            // Refused with no alert at all. A malformed address is the page's
            // own bug to surface, and a system dialog about a string the user
            // never typed reads as the app malfunctioning.
            let message = (error as? AppConfig.OriginError)?.message ?? error.localizedDescription
            reply(false, ["error": message])
            return
        }
        // Already pointed there. Not a no-op worth being strict about: the
        // obvious thing for a page to do on mount is report where it thinks it
        // is, and answering that with a full reload would be an infinite one.
        guard url != AppConfig.origin else {
            reply(true, ["applied": false, "origin": AppConfig.origin.absoluteString])
            return
        }
        let alert = UIAlertController(
            title: "Switch server?",
            // The address on its own line. It is the only part worth reading:
            // it decides where the machine key goes and who gets the microphone.
            message: "\(AppConfig.origin.absoluteString)\n→\n\(url.absoluteString)\n\nThe app will reload, and you'll need to sign in there.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.originConfirmation = nil
            reply(false, ["error": "cancelled", "cancelled": true])
        })
        let confirm = UIAlertAction(title: "Switch", style: .default) { [weak self] _ in
            self?.originConfirmation = nil
            do {
                try AppConfig.setOrigin(url.absoluteString)
            } catch {
                // Unreachable today — the same string already passed
                // `normalizeOrigin` above — but the two calls are separated by
                // however long the alert was on screen, so this stays an
                // answered failure rather than a dropped question.
                reply(false, ["error": (error as? AppConfig.OriginError)?.message ?? error.localizedDescription])
                return
            }
            // Answer first, switch second. `switchOrigin` tears down the
            // document that asked, and a reply evaluated into a dead page is one
            // its caller waits out the full timeout for. Both are main-queue
            // hops and the queue is FIFO, so the reply's JavaScript is issued
            // before the load begins.
            reply(true, ["applied": true, "origin": AppConfig.origin.absoluteString])
            DispatchQueue.main.async { self?.switchOrigin() }
        }
        alert.addAction(confirm)
        alert.preferredAction = confirm
        originConfirmation = alert
        // A dialog that never reached the screen must not leave the page
        // waiting for an answer nobody can give.
        if !presentOnTop(alert) {
            originConfirmation = nil
            reply(false, ["error": "the confirmation could not be shown"])
        }
    }

    @objc private func didEnterForeground() {
        // Nothing about audio here on purpose. The scene tears the session down on
        // the way out, and the web layer switches it back on when it actually
        // opens a stream (`onMicActive`) — re-activating on every foreground
        // instead would duck whatever the user is listening to for the rest of
        // the launch, after a single voice message.
        bridge.notifyForeground()
    }

    // MARK: - Live Activity

    private func applyLiveActivity(_ cmd: LiveActivityCommand) {
        switch cmd.action {
        case .start:
            guard let state = cmd.state else { return }
            LiveActivityManager.start(
                sessionId: cmd.sessionId,
                agentName: cmd.agentName,
                machineName: cmd.machineName,
                state: state
            ) { [weak self] token, sessionId, sinceEpoch in
                self?.bridge.sendLiveActivityToken(
                    kind: "update", token: token, sessionId: sessionId, sinceMs: sinceEpoch * 1000
                )
            }
        case .update:
            guard let state = cmd.state else { return }
            LiveActivityManager.update(sessionId: cmd.sessionId, state: state)
        case .end:
            LiveActivityManager.end(sessionId: cmd.sessionId, state: cmd.state)
        case .endAll:
            LiveActivityManager.endAll()
        }
    }

    // MARK: - Push plumbing (called by AppDelegate)

    func deliverPushToken(_ token: String, env: ApnsEnvironment) {
        bridge.deliver(token: token, env: env)
    }

    func openDeepLink(_ path: String) {
        bridge.deliver(path: path)
    }

    // MARK: - Audio

    /// Put the audio session in a category that can actually record. Left at the
    /// default `.soloAmbient`, `getUserMedia` succeeds and then captures pure
    /// silence — a failure mode with no error message anywhere.
    private func activateRecordingSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord, mode: .default,
                options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP]
            )
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            NSLog("[hermit] audio session failed: \(error)")
        }
    }

    /// Hand the audio route back to whatever was playing before.
    func releaseAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// MARK: - Presenting on top

extension UIViewController {
    /// Present from whatever is actually frontmost. UIKit refuses (with a log line
    /// and nothing else) when the receiver is already presenting something, which
    /// is easy to hit here: a share sheet raised while a popup web view is up, a
    /// JS alert fired from inside that popup.
    @discardableResult
    func presentOnTop(_ vc: UIViewController, animated: Bool = true) -> Bool {
        var top: UIViewController = self
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        guard top.view.window != nil else { return false }
        top.present(vc, animated: animated)
        return true
    }
}

// MARK: - WKUIDelegate

extension WebViewController: WKUIDelegate {
    /// The reason this app exists.
    ///
    /// iOS re-asks for microphone permission on EVERY `getUserMedia` call, which
    /// makes continuous voice input unusable in Safari and in an installed PWA.
    /// Inside a WKWebView the host app answers instead — so the system asks once,
    /// at first use, and the web layer never sees a prompt again.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // Only our own origin, and only the microphone: this shell has no feature
        // that needs the camera, so a request for one is not something to grant
        // silently on the user's behalf.
        guard origin.host == AppConfig.host, type == .microphone else {
            decisionHandler(.deny)
            return
        }
        // Also activated by `onMicActive` a moment later; doing it here too means
        // the very first recording is not racing the round trip.
        activateRecordingSession()
        decisionHandler(.grant)
    }

    /// `target="_blank"` and `window.open` produce no view to return, so route them
    /// the same way a normal link would go.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        guard AppConfig.isInternal(url) else {
            openExternally(url)
            return nil
        }
        // Internal, but the page asked for a NEW window: the image lightbox's
        // "open original", a markdown link with target="_blank". Loading it into
        // this web view — what the shell used to do — throws away the open
        // session, its scroll position and any unsent draft, with only a back
        // swipe to undo it. Safari is no good either: it is a different cookie and
        // storage jar, so an authed route would land on the sign-in screen.
        //
        // So: a second web view against the same persistent data store, presented
        // on top. Close it and the session underneath is exactly where it was.
        // Returning nil (rather than handing WebKit the new view) keeps this off
        // the opener path entirely — nothing here needs `window.opener`, and a
        // configuration WebKit owns is not ours to reshape.
        let popup = PopupWebViewController(url: url)
        popup.modalPresentationStyle = .pageSheet
        presentOnTop(popup)
        return nil
    }

    /// Who is speaking. A dialog raised by the page itself needs no title; one
    /// raised by a SUBFRAME does, because the live-preview panel embeds
    /// agent-authored HTML from another origin with `allow-modals`, and an
    /// untitled system alert reads as the app's own words. Safari names the site
    /// for the same reason.
    private func dialogTitle(for frame: WKFrameInfo) -> String? {
        guard !frame.isMainFrame else { return nil }
        let host = frame.securityOrigin.host
        return host.isEmpty ? "Embedded content" : host
    }

    // JS dialogs have no native presentation in a web view — supply one, or
    // `alert()` silently does nothing.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: dialogTitle(for: frame), message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        // Presented on top, and the handler runs if that fails: WebKit blocks the
        // page until it is called, so a dropped presentation would freeze the tab.
        if !presentOnTop(a) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: dialogTitle(for: frame), message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        if !presentOnTop(a) { completionHandler(false) }
    }
}

// MARK: - WKNavigationDelegate

extension WebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // `<a download>` / a blob the page built to save a file. First, because it
        // is frame-agnostic: an `<a download>` inside the preview iframe is still a
        // save, not a navigation. Without this the navigation is simply allowed and
        // the whole dashboard is replaced by the raw image or PDF — the "no way
        // back" trap the web side has its own workarounds for. The download
        // delegate below turns it into a share sheet.
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // Only the MAIN frame is the shell's own navigation. A subframe belongs to
        // the page, and the page deliberately embeds another origin: the live
        // preview panel iframes preview.swaylab.ai so agent-authored HTML can
        // never run on the dashboard's origin. Routing that through the off-site
        // branch left the panel blank and slid a Safari sheet over the whole app.
        // `targetFrame` is nil for a new window (target="_blank"), which must keep
        // falling through to Safari — so this only relaxes real subframes.
        if let target = navigationAction.targetFrame, !target.isMainFrame {
            decisionHandler(.allow)
            return
        }
        if AppConfig.isInternal(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            decisionHandler(.allow)
            return
        }
        // Anything off-site leaves the shell: in Safari for web pages, in the
        // owning app for tel:/mailto:. Never navigate the shell itself away from
        // the dashboard — there'd be no way back.
        decisionHandler(.cancel)
        openExternally(url)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // Attachments the web view can't render (zips, office docs) become
        // downloads instead of a blank page.
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        bridge.pageWillReload()
        // The outgoing document's answer does not carry: a deep link into /chat
        // and a reload back to a wide iPad layout want opposite things. Back to
        // the safe default; the new page re-asserts on mount.
        webView.allowsBackForwardNavigationGestures = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        offlineView.hide()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Only a failure to load the document at all is worth an offline screen —
        // a cancelled navigation (a redirect, a fast second tap) is routine.
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        offlineView.show(in: view, message: error.localizedDescription)
    }

    private func openExternally(_ url: URL) {
        if url.scheme == "http" || url.scheme == "https" {
            let safari = SFSafariViewController(url: url)
            safari.modalPresentationStyle = .formSheet
            presentOnTop(safari)
        } else if UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        }
    }
}

// MARK: - WKDownloadDelegate

extension WebViewController: WKDownloadDelegate {
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        completionHandler(DownloadScratch.destination(for: suggestedFilename))
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = download.progress.fileURL else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // iPad requires an anchor or this crashes on presentation.
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(
            x: view.bounds.midX, y: view.bounds.maxY, width: 0, height: 0
        )
        // On top, not on `self`: with a popup web view already up, presenting from
        // here is a no-op and the finished download vanishes without a word.
        presentOnTop(share)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("[hermit] download failed: \(error)")
    }
}
