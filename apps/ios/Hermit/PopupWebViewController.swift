import SafariServices
import UIKit
import WebKit

/// A second web view, on top of the app, for anything the page opened with
/// `target="_blank"`.
///
/// It exists because the two obvious answers are both wrong. Loading the URL into
/// the main web view discards the open chat, its scroll position and any unsent
/// draft. Handing it to Safari puts it in a different cookie and storage jar, so
/// an authed dashboard route arrives at the sign-in screen.
///
/// It builds its own web view against `WKWebsiteDataStore.default()` — the same
/// jar the main view uses — rather than adopting the configuration WebKit hands
/// to `createWebViewWith`. Same cookies and localStorage, so an authed route just
/// works, without inheriting the bridge's message handler or the shell marker
/// script (this view gets its insets from UIKit, which is what
/// `contentInsetAdjustmentBehavior = .automatic` below is for).
final class PopupWebViewController: UIViewController {
    let webView: WKWebView
    private let url: URL

    init(url: URL) {
        self.url = url
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .appBackground
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        // Match the app background so a dark-mode page does not flash white while
        // the document loads.
        webView.isOpaque = false
        webView.backgroundColor = .appBackground
        webView.scrollView.backgroundColor = .appBackground

        let bar = UIToolbar()
        let done = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(close))
        let share = UIBarButtonItem(barButtonSystemItem: .action, target: self, action: #selector(shareURL))
        bar.items = [share, UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil), done]

        for v in [webView, bar] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        webView.load(URLRequest(url: url))
    }

    @objc private func close() { dismiss(animated: true) }

    @objc private func shareURL(_ sender: UIBarButtonItem) {
        guard let url = webView.url else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.barButtonItem = sender
        presentOnTop(share)
    }
}

extension PopupWebViewController: WKUIDelegate {
    /// `window.close()` from the popup's own page.
    func webViewDidClose(_ webView: WKWebView) { close() }

    /// A popup opened from a popup. Dashboard URLs get another popup — Safari is a
    /// different cookie and storage jar, which is the exact failure this class was
    /// written to avoid, and it does not stop being true one hop in. Anything else
    /// belongs in Safari.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if AppConfig.isInternal(url) {
            let next = PopupWebViewController(url: url)
            next.modalPresentationStyle = .pageSheet
            presentOnTop(next)
        } else if url.scheme == "http" || url.scheme == "https" {
            presentOnTop(SFSafariViewController(url: url))
        }
        return nil
    }
}

extension PopupWebViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Same rule as the main shell: a `download` attribute means save, not
        // navigate. Everything else is allowed — this view is already the "somewhere
        // else" the page asked for.
        decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
}

extension PopupWebViewController: WKDownloadDelegate {
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        completionHandler(DownloadScratch.destination(for: suggestedFilename))
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = download.progress.fileURL else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY, width: 0, height: 0)
        presentOnTop(share)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("[hermit] popup download failed: \(error)")
    }
}

/// Where a download lands before the share sheet picks it up. A unique
/// subdirectory per file: the destination must not already exist, and two
/// downloads of `report.pdf` would otherwise collide.
enum DownloadScratch {
    static func destination(for filename: String) -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(filename)
    }
}
