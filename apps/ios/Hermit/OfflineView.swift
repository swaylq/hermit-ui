import UIKit

extension UIColor {
    /// Matches the dashboard's `background` token so launch → web hand-off and the
    /// offline screen don't flash a different colour.
    static var appBackground: UIColor {
        UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.035, alpha: 1) : .white }
    }
}

/// Shown when the document itself fails to load. The web app's own offline.html
/// can't help here: a service worker has nothing to serve if the very first
/// navigation never reached the network.
///
/// It is also the only screen that can fix a wrong address, which is why it names
/// the one it tried and offers a way to change it — see `presentOriginEditor` in
/// WebViewController.
final class OfflineView: UIView {
    private let onRetry: () -> Void
    private let onChangeServer: () -> Void
    private let detail = UILabel()
    private let address = UILabel()

    init(onRetry: @escaping () -> Void, onChangeServer: @escaping () -> Void) {
        self.onRetry = onRetry
        self.onChangeServer = onChangeServer
        super.init(frame: .zero)
        build()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    private func build() {
        backgroundColor = .appBackground

        let title = UILabel()
        title.text = "Can't reach Hermit"
        title.font = .preferredFont(forTextStyle: .headline)
        title.textColor = .label
        title.textAlignment = .center

        detail.font = .preferredFont(forTextStyle: .footnote)
        detail.textColor = .secondaryLabel
        detail.textAlignment = .center
        detail.numberOfLines = 3

        // WHICH server failed. Without it "Can't reach Hermit" reads as "the
        // network is down" even when the real answer is that the address is
        // wrong — and this screen is where that gets corrected. Truncated in the
        // middle so a long host keeps both its start and its port.
        address.font = .monospacedSystemFont(
            ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .regular)
        address.textColor = .tertiaryLabel
        address.textAlignment = .center
        address.numberOfLines = 1
        address.lineBreakMode = .byTruncatingMiddle

        var retryConfig = UIButton.Configuration.borderedProminent()
        retryConfig.title = "Retry"
        let retry = UIButton(configuration: retryConfig, primaryAction: UIAction { [weak self] _ in
            self?.onRetry()
        })

        // Plain, not a second prominent button: the usual answer here is still
        // "try again", and two filled buttons would make the rarer one look like
        // the expected one.
        var changeConfig = UIButton.Configuration.plain()
        changeConfig.title = "Change server"
        let change = UIButton(configuration: changeConfig, primaryAction: UIAction { [weak self] _ in
            self?.onChangeServer()
        })

        let stack = UIStackView(arrangedSubviews: [title, detail, address, retry, change])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        // The two buttons are one cluster; the 12pt gap is for the text above.
        stack.setCustomSpacing(0, after: retry)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -32),
        ])
    }

    func show(in parent: UIView, message: String) {
        detail.text = message
        // Read at show time, not at build time: after a failed switch this view is
        // reused, and a stale address would name the wrong server.
        address.text = AppConfig.origin.absoluteString
        guard superview == nil else { return }
        translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(self)
        NSLayoutConstraint.activate([
            topAnchor.constraint(equalTo: parent.topAnchor),
            bottomAnchor.constraint(equalTo: parent.bottomAnchor),
            leadingAnchor.constraint(equalTo: parent.leadingAnchor),
            trailingAnchor.constraint(equalTo: parent.trailingAnchor),
        ])
    }

    func hide() {
        removeFromSuperview()
    }
}
