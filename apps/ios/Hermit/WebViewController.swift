import AVFoundation
import SafariServices
import UIKit
import WebKit

/// The whole app: one full-screen web view pointed at the dashboard, plus the
/// handful of native behaviours a web page can't do for itself.
final class WebViewController: UIViewController {
    private var webView: WKWebView!
    private let bridge = NativeBridge()
    private lazy var offlineView = OfflineView { [weak self] in self?.reload() }

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
        // Persistent store: the dashboard keeps its machine keys in localStorage,
        // so this is what makes "enter the key once" true across launches.
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

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
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

    @objc private func didEnterForeground() {
        // Nothing about audio here on purpose. The scene tears the session down on
        // the way out, and the web layer switches it back on when it actually
        // opens a stream (`onMicActive`) — re-activating on every foreground
        // instead would duck whatever the user is listening to for the rest of
        // the launch, after a single voice message.
        bridge.notifyForeground()
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
