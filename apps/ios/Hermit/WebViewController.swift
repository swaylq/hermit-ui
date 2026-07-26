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

    private func load() {
        webView.load(URLRequest(url: AppConfig.origin))
    }

    private func reload() {
        offlineView.hide()
        if webView.url == nil { load() } else { webView.reload() }
    }

    @objc private func didEnterForeground() {
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
        activateRecordingSession()
        decisionHandler(.grant)
    }

    /// `target="_blank"` and `window.open` produce no view to return, so route them
    /// the same way a normal link would go.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if AppConfig.isInternal(url) { webView.load(URLRequest(url: url)) } else { openExternally(url) }
        }
        return nil
    }

    // JS dialogs have no native presentation in a web view — supply one, or
    // `alert()` silently does nothing.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
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
            present(safari, animated: true)
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
        // A unique subdirectory keeps two downloads of the same filename from
        // colliding (the destination must not already exist).
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        completionHandler(dir.appendingPathComponent(suggestedFilename))
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = download.progress.fileURL else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // iPad requires an anchor or this crashes on presentation.
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(
            x: view.bounds.midX, y: view.bounds.maxY, width: 0, height: 0
        )
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("[hermit] download failed: \(error)")
    }
}
