import Foundation
import WebKit

/// The web ⇄ native seam.
///
/// The shell holds NO credentials. It knows its APNs device token; the web layer
/// knows the machine keys. So the token is handed across and the web side does the
/// registering through its own authenticated client — see lib/native-bridge.ts.
///
/// Both directions have to tolerate arriving early. A push token can land before
/// the web view has finished loading, and a notification tap can launch the app
/// cold. Anything that arrives before the page says `ready` is parked here and
/// replayed the moment it does.
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

    private weak var webView: WKWebView?
    private var pageReady = false
    private var pendingToken: (token: String, env: ApnsEnvironment)?
    private var pendingPath: String?

    func attach(to webView: WKWebView) {
        self.webView = webView
    }

    /// The page navigated — anything the web side registered on `window` is gone
    /// until it tells us it's back.
    func pageWillReload() {
        pageReady = false
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
    /// machine key; native never sees one.
    func sendLiveActivityToken(kind: String, token: String, sessionId: String, sinceMs: Double) {
        guard let webView else { return }
        call(webView, "onLiveActivityToken", [kind, token, sessionId, sinceMs])
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
