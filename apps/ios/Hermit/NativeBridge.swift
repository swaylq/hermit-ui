import Foundation
import WebKit

/// The web ⇄ native seam.
///
/// PUSH REGISTRATION stays the page's job. The shell knows its APNs device
/// token; the web layer knows the machine keys, and a phone holding three of
/// them has to be registered against all three machines — which one key cannot
/// do. So the token is handed across and the web side registers through its own
/// authenticated client (see lib/native-bridge.ts). None of that changed when
/// the shell started making requests of its own.
///
/// The keyring itself has lived in the device Keychain since M1 (Keychain.swift,
/// `keychain.get`/`.set`/`.clear`/`.setActive` in WebViewController.answer), as
/// one opaque string per origin. As of M3 native code also READS it, in exactly
/// one file — KeyStore.swift — so the native session list can make the one query
/// it needs. Nothing else in this app opens that blob.
///
/// Two shapes travel over it. Most messages are one-way announcements, which is
/// why both directions have to tolerate arriving early: a push token can land
/// before the web view has finished loading, and a notification tap can launch
/// the app cold, so anything that arrives before the page says `ready` is parked
/// here and replayed the moment it does. The other shape is a QUESTION, paired
/// with its answer by an id the asker invents and the answerer echoes back:
///
///     web → native   { type: 'req',   id, method, params }
///                    window.__hermitNative.onReply(id, ok, payload)
///     native → web   window.__hermitNative.onRequest(id, method, params)
///                    { type: 'reply', id, ok, payload }
///
/// The asker owns the timeout, five seconds on both sides, so no caller is left
/// holding a completion block that never runs.
final class NativeBridge: NSObject {
    /// Message-handler name; must match `window.webkit.messageHandlers.hermit`.
    static let handlerName = "hermit"

    /// Ask the OS for notification permission (prompting only if it has never been
    /// asked) and report the outcome. Set by the view controller; kept as a closure
    /// so this file needs no opinion about where the app delegate lives.
    var onRequestPush: ((@escaping (String, Bool) -> Void) -> Void)?
    /// Read the standing permission answer without ever prompting.
    var onReadPushStatus: ((@escaping (String, Bool) -> Void) -> Void)?
    /// A live microphone stream opened (true) or was torn down (false).
    var onMicActive: ((Bool) -> Void)?
    /// Play one haptic, by name. See Haptics.swift.
    var onHaptic: ((String) -> Void)?
    /// May the shell's own back/forward edge swipe run right now? The page owns
    /// horizontal gestures it has drawn something for; see WebViewController.
    var onEdgeSwipe: ((Bool) -> Void)?
    /// Start / update / end the Lock Screen + Dynamic Island activity for one
    /// session. See LiveActivityManager.
    var onLiveActivity: ((LiveActivityCommand) -> Void)?
    /// The page is asking whether this device can show one at all.
    var onLiveActivityStatus: (() -> Void)?
    /// Answer one `{type:'req'}` from the page: `(method, params, reply)`.
    ///
    /// Nil is not "ignore it": with no handler the bridge replies `unknown
    /// method` straight away, so a page calling something its shell is too old to
    /// know fails in a millisecond instead of sitting out the full timeout.
    var onRequest: ((String, [String: Any], @escaping (Bool, Any?) -> Void) -> Void)?

    /// How long each side waits for the other's answer before giving up. The web
    /// half of this number is `REPLY_TIMEOUT_MS` in lib/native-bridge.ts.
    static let replyTimeout: TimeInterval = 5

    private weak var webView: WKWebView?
    private var pageReady = false
    private var pendingToken: (token: String, env: ApnsEnvironment)?
    private var pendingPath: String?
    /// Questions THIS side asked the page, keyed by the id it was asked under.
    /// Main-thread only, like everything WebKit hands us.
    private var pendingReplies: [String: (Bool, Any?) -> Void] = [:]

    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    /// The page navigated — anything the web side registered on `window` is gone
    /// until it tells us it's back.
    func pageWillReload() {
        pageReady = false
        // Every question in flight was asked of a document that is about to stop
        // existing, so nothing will ever answer it. Fail them now rather than
        // leave each caller to find out five seconds later.
        let orphans = Array(pendingReplies.values)
        pendingReplies.removeAll()
        for done in orphans { done(false, nil) }
    }

    // MARK: - native → web

    func deliver(token: String, env: ApnsEnvironment) {
        pendingToken = (token, env)
        flush()
    }

    func deliver(path: String) {
        pendingPath = path
        flush()
    }

    private func flush() {
        guard pageReady, let webView else { return }
        if let t = pendingToken {
            pendingToken = nil
            call(webView, "onPushToken", [t.token, t.env.rawValue])
        }
        if let p = pendingPath {
            pendingPath = nil
            call(webView, "onDeepLink", [p])
        }
    }

    /// Tell the page where notification permission stands. Sent unprompted after
    /// `requestPush` / `pushStatus`, so the Settings → Push card can show the
    /// truth instead of guessing from browser APIs a WKWebView doesn't have.
    func sendPushStatus(_ status: String, registered: Bool) {
        guard let webView else { return }
        call(webView, "onPushStatus", [status, registered])
    }

    /// What the device can do about Live Activities. Sent unprompted after
    /// `liveActivityStatus`, so the page can stop sending updates to a phone
    /// that has them switched off rather than throwing them into a void.
    func sendLiveActivityStatus(supported: Bool, enabled: Bool) {
        guard let webView else { return }
        call(webView, "onLiveActivityStatus", [supported, enabled])
    }

    /// A push token for the activity system. `kind` is "update" (addresses one
    /// running activity, so it carries the session it belongs to) or "start"
    /// (app-wide, no session — the empty string). The page registers it with the
    /// machine key. Native holds that key only as an opaque blob in the Keychain
    /// and never uses one itself.
    func sendLiveActivityToken(kind: String, token: String, sessionId: String, sinceMs: Double) {
        guard let webView else { return }
        call(webView, "onLiveActivityToken", [kind, token, sessionId, sinceMs])
    }

    // MARK: - asking the page something

    /// Ask the page a question and get its answer back.
    ///
    /// `completion` runs exactly once and always on the main queue: with the
    /// page's answer, or with `(false, nil)` if the page is not there yet, never
    /// answers, or navigates away mid-question. Callers are meant to lean on
    /// "exactly once" — a Keychain migration or an outbox flush that can hang
    /// forever is worse than one that fails.
    func request(_ method: String, params: [String: Any] = [:], completion: @escaping (Bool, Any?) -> Void) {
        // Before `ready` there is no `window.__hermitNative` to call, and the
        // reply would be swallowed by the `&&` in `call`. Say so immediately.
        guard pageReady, let webView else { completion(false, nil); return }
        let id = UUID().uuidString
        pendingReplies[id] = completion
        call(webView, "onRequest", [id, method, params])
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.replyTimeout) { [weak self] in
            guard let done = self?.pendingReplies.removeValue(forKey: id) else { return }
            done(false, nil)
        }
    }

    /// Answer one of the page's questions. `id` is echoed back exactly as it
    /// arrived — it is the page's own bookkeeping, not ours to interpret.
    private func reply(_ id: String, ok: Bool, payload: Any?) {
        guard let webView else { return }
        let value = payload ?? NSNull()
        // A payload Foundation cannot serialise would make `call` drop the whole
        // message, and the page would then wait out its entire timeout for an
        // answer that already exists. Fail it now instead.
        guard JSONSerialization.isValidJSONObject([id, ok, value]) else {
            call(webView, "onReply", [id, false, NSNull()])
            return
        }
        call(webView, "onReply", [id, ok, value])
    }

    /// Invoke `window.__hermitNative.<fn>(...)`. Arguments go through JSON so a
    /// quote or backslash in a path can't break out into the surrounding script.
    private func call(_ webView: WKWebView, _ fn: String, _ args: [Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: args),
              let json = String(data: data, encoding: .utf8)
        else { return }
        let js = "window.__hermitNative && window.__hermitNative.\(fn).apply(null, \(json))"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Nudge the page to re-check its connections after the app was backgrounded.
    /// The dashboard's SSE watchdog already reconnects on a visibility change, so
    /// synthesising one is enough — no bespoke protocol needed.
    func notifyForeground() {
        // Only when the document already agrees it is visible. WKWebView fires a
        // real visibilitychange of its own across background/foreground, and the
        // chat page's handler DISCONNECTS when `document.hidden` is true — so a
        // synthetic event that lands before WebKit flips the flag would tear the
        // stream down instead of reviving it.
        // Next runloop, not now: this fires from `willEnterForegroundNotification`,
        // and whether WebKit has already flipped `document.hidden` back to false by
        // then depends on which observer was registered first — an undocumented
        // ordering the page would silently lose its reconnect to.
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "if (!document.hidden) document.dispatchEvent(new Event('visibilitychange'))",
                completionHandler: nil)
        }
    }
}

// MARK: - web → native

extension NativeBridge: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Main frame only. `messageHandlers.hermit` is exposed to EVERY frame, and
        // the live-preview panel iframes preview.swaylab.ai — a separate origin on
        // purpose, because it serves agent-authored HTML that must never run beside
        // the dashboard's keyring. Without this guard that page could hand the
        // shell `origins` (poisoning AppConfig.knownHosts, which is what decides
        // "stays in the app" — an attacker host would then open in a chrome-less
        // popup), switch the microphone's audio session on, or raise the system
        // notification prompt. `forMainFrameOnly:` on the user script above covers
        // the other direction; this is the same boundary, coming back.
        guard message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any],
              let type = body["type"] as? String
        else { return }

        switch type {
        case "ready":
            pageReady = true
            flush()
        case "registered":
            let ok = body["ok"] as? Int ?? 0
            let of = body["of"] as? Int ?? 0
            NSLog("[hermit] push registered for \(ok)/\(of) machines")
        case "mic":
            onMicActive?(body["active"] as? Bool ?? false)
        case "haptic":
            // No default style: a message that lost its `style` should do
            // nothing, not pick one. Haptics.play ignores what it does not know.
            onHaptic?(body["style"] as? String ?? "")
        case "liveActivity":
            if let cmd = LiveActivityCommand(body) { onLiveActivity?(cmd) }
        case "liveActivityStatus":
            onLiveActivityStatus?()
        case "edgeSwipe":
            // Absent/garbled `enabled` falls back to false — the failure this
            // exists to fix (the shell eating the drawer's swipe) is the one
            // that happens when it is on, so the safe default is off.
            onEdgeSwipe?(body["enabled"] as? Bool ?? false)
        case "origins":
            // The deployments this device holds a key for. See AppConfig.knownHosts.
            AppConfig.setKnownHosts(body["origins"] as? [String] ?? [])
        case "requestPush":
            // The page has at least one machine key, so there is finally somewhere
            // to register a token. See AppDelegate for why the app does not ask at
            // launch instead.
            onRequestPush? { [weak self] status, registered in
                self?.sendPushStatus(status, registered: registered)
            }
        case "pushStatus":
            onReadPushStatus? { [weak self] status, registered in
                self?.sendPushStatus(status, registered: registered)
            }
        case "req":
            // A question. Pairing the answer back to its id is all this does;
            // answering is `onRequest`'s job.
            guard let id = body["id"] as? String, !id.isEmpty else { return }
            let method = body["method"] as? String ?? ""
            guard let handler = onRequest else {
                reply(id, ok: false, payload: ["error": "unknown method: \(method)"])
                return
            }
            var answered = false
            handler(method, body["params"] as? [String: Any] ?? [:]) { [weak self] ok, payload in
                // Hop to main, and drop everything after the first answer. A
                // handler that fires its callback twice — a retry racing its own
                // completion — must not send two replies for one id: the page
                // frees the id on the first, so the second would land on
                // whichever question took that id next.
                DispatchQueue.main.async {
                    guard !answered else { return }
                    answered = true
                    self?.reply(id, ok: ok, payload: payload)
                }
            }
        case "reply":
            // The page answering something `request(_:params:completion:)` asked.
            // An id that is no longer in the table already timed out, and its
            // completion has run — dropping this is the correct end.
            guard let id = body["id"] as? String,
                  let done = pendingReplies.removeValue(forKey: id) else { return }
            done(body["ok"] as? Bool ?? false, body["payload"])
        default:
            break
        }
    }
}

// MARK: - The page's Live Activity commands

/// One `{type:'liveActivity', …}` message, parsed.
///
/// Parsed here rather than in the view controller so a malformed message dies at
/// the boundary: the page and this app ship on different clocks, and a missing
/// field should mean "ignore this one", never a half-applied activity.
struct LiveActivityCommand {
    enum Action: String { case start, update, end, endAll }

    let action: Action
    let sessionId: String
    let agentName: String
    let machineName: String?
    /// Absent on `end` (the activity keeps whatever it last showed) and on
    /// `endAll`.
    let state: SessionActivityAttributes.ContentState?

    init?(_ body: [String: Any]) {
        guard let raw = body["action"] as? String, let action = Action(rawValue: raw) else { return nil }
        self.action = action
        let sid = body["sessionId"] as? String ?? ""
        // Every action except endAll is about one session; without an id there is
        // nothing to address.
        guard action == .endAll || !sid.isEmpty else { return nil }
        self.sessionId = sid
        self.agentName = body["agentName"] as? String ?? ""
        let machine = body["machineName"] as? String
        self.machineName = (machine?.isEmpty ?? true) ? nil : machine

        if let s = body["state"] as? [String: Any] {
            // A line longer than the budget is truncated rather than rejected:
            // the payload cap is a hard limit with no error, and half a sentence
            // beats a silently dropped update.
            let line = (s["line"] as? String ?? "")
            let title = (s["title"] as? String ?? "")
            self.state = SessionActivityAttributes.ContentState(
                phase: s["phase"] as? String ?? SessionPhase.working.rawValue,
                title: String(title.prefix(SessionActivityAttributes.ContentState.maxLine)),
                line: String(line.prefix(SessionActivityAttributes.ContentState.maxLine)),
                // The page sends JavaScript milliseconds; this struct stores
                // seconds, because that is what the SERVER will put in an APNs
                // content-state. One conversion, at the edge, in one place.
                sinceEpoch: (s["sinceMs"] as? Double ?? Date().timeIntervalSince1970 * 1000) / 1000,
                queued: s["queued"] as? Int,
                ctxPct: s["ctxPct"] as? Int
            )
        } else {
            self.state = nil
            // start with no state would raise an empty activity.
            if action == .start { return nil }
        }
    }
}
