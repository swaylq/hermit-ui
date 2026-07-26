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
final class OfflineView: UIView {
    private let onRetry: () -> Void
    private let detail = UILabel()

    init(onRetry: @escaping () -> Void) {
        self.onRetry = onRetry
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

        var config = UIButton.Configuration.borderedProminent()
        config.title = "Retry"
        let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in
            self?.onRetry()
        })

        let stack = UIStackView(arrangedSubviews: [title, detail, button])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
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
