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

    /// Invoke `window.__hermitNative.<fn>(...)`. Arguments go through JSON so a
    /// quote or backslash in a path can't break out into the surrounding script.
    private func call(_ webView: WKWebView, _ fn: String, _ args: [String]) {
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
        webView?.evaluateJavaScript("document.dispatchEvent(new Event('visibilitychange'))",
                                    completionHandler: nil)
    }
}

// MARK: - web → native

extension NativeBridge: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
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
        default:
            break
        }
    }
}
