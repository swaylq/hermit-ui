import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// The session detail panel's state, its two queries and its one mutation.
///
/// Split from the view for the reason the rest of this app is: the view draws
/// what `SessionDetailCore` answers, and everything that talks to a server or
/// holds a timer lives out here where a screenshot tool can leave it out.
@MainActor
final class SessionDetailModel: ObservableObject {
    enum Copied { case idle, ok, fail }

    let sessionId: String
    /// A share link gets no machine-level control. Not read from a scope route
    /// yet — this shell only ever holds a full key — so it is a stored property
    /// rather than a guess, and the fixture covers both values.
    let scoped: Bool

    @Published private(set) var detail: DetailSnapshot?
    @Published private(set) var config: BackendsConfig?
    @Published private(set) var loading = true
    /// The query answered `null`: the row is gone (trashed, or another agent's).
    @Published private(set) var gone = false
    @Published private(set) var error: String?
    @Published private(set) var saving = false
    @Published private(set) var saveError: String?
    @Published private(set) var restarted = false
    @Published private(set) var copied: Copied = .idle
    /// What the user has CHANGED, and nothing else.
    @Published private(set) var form = DetailForm.empty

    /// Asked to confirm a switch. The view has no say in the words.
    @Published var pendingSwitch: DetailSwitchPrompt?

    var onClose: (() -> Void)?
    var url: String

    private var stamped: String?
    private var poll: Task<Void, Never>?
    private let origin: URL?

    init(sessionId: String, scoped: Bool = false) {
        self.sessionId = sessionId
        self.scoped = scoped
        let entry = KeyStore.active()
        self.origin = entry.map { KeyStore.base(for: $0) }
        // The web shows the LINK, not the bare id: the id on its own was only
        // ever a step towards a url someone had to assemble by hand.
        self.url = SessionDetailCore.sessionUrl(
            origin: (self.origin?.absoluteString).map { $0.hasSuffix("/") ? String($0.dropLast()) : $0 } ?? "",
            sessionId: sessionId
        )
    }

    var view: DetailPickerView {
        SessionDetailCore.pickerView(d: detail, cfg: config, form: form, scoped: scoped)
    }

    // MARK: Loading

    /// `refetchInterval: 10_000` while open — this query carries a message count
    /// and the agent lookup, which have no business riding the chat's 5s poll.
    func start() {
        guard poll == nil, let origin else { loading = false; return }
        let api = HermitAPI(origin: origin, key: { KeyStore.active()?.key ?? "" })
        poll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetch(api)
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }

    func stop() {
        poll?.cancel()
        poll = nil
    }

    private struct SessionInput: Encodable { let sessionId: String }

    private func fetch(_ api: HermitAPI) async {
        // The config is a settings-page answer: stale for a minute is fine, and
        // it is fetched once rather than every ten seconds.
        if config == nil {
            config = try? await api.query("machines.getBackendsConfig", as: BackendsConfig?.self) ?? nil
        }
        do {
            let d = try await api.query("chat.sessionDetail",
                                        input: SessionInput(sessionId: sessionId),
                                        as: DetailSnapshot?.self)
            gone = (d == nil)
            error = nil
            if let d {
                detail = d
                // The server's answer as one string. When it moves — our save
                // landed, or another device switched this session — the form is
                // dropped, which is what makes a refetch safe mid-edit.
                let stamp = SessionDetailCore.stamp(sessionId: sessionId, d)
                if let stamp, stamped != stamp {
                    stamped = stamp
                    form = .empty
                    saveError = nil
                }
            }
        } catch {
            // A poll that fails keeps what it had. Only the FIRST one has
            // nothing to keep, and that is the one worth saying out loud.
            if detail == nil { self.error = "\(error)" }
        }
        loading = false
    }

    // MARK: Editing

    func pick(_ id: String) {
        form.runtime = id
        saveError = nil
    }

    func pickMode(_ m: String) {
        form.mode = PiModes.isPiMode(m) ? m : PiModes.fleetDefault
        saveError = nil
    }

    func resetForm() {
        form = .empty
        saveError = nil
    }

    /// Ask first. The words come from the core, which knows whether the running
    /// context survives the move — the one thing that is expensive to get wrong
    /// in either direction.
    func apply() {
        guard let d = detail, view.dirty else { return }
        pendingSwitch = SessionDetailCore.switchPrompt(d, config, view)
    }

    func confirmSwitch() {
        pendingSwitch = nil
        guard let d = detail, let origin, view.dirty else { return }
        let payload = SessionDetailCore.savePayload(d, view)
        saving = true
        saveError = nil
        let api = HermitAPI(origin: origin, key: { KeyStore.active()?.key ?? "" })
        Task { [weak self] in
            struct Result: Decodable { let restarted: Bool? }
            do {
                let r = try await api.mutate("chat.setSessionRuntime", input: payload, as: Result.self)
                await MainActor.run {
                    guard let self else { return }
                    self.saving = false
                    self.restarted = r.restarted ?? false
                    // Snap back to the truth by clearing the override rather
                    // than by racing a re-seed: the next poll carries a new
                    // stamp and drops the form anyway, and this makes the
                    // button stop saying "switching…" without waiting for it.
                    self.form = .empty
                    self.stamped = nil
                }
            } catch {
                await MainActor.run {
                    self?.saving = false
                    self?.saveError = "\(error)"
                }
            }
        }
    }

    func cancelSwitch() { pendingSwitch = nil }

    func copyUrl() {
        #if canImport(UIKit)
        UIPasteboard.general.string = url
        #endif
        copied = .ok
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            self?.copied = .idle
        }
    }

    func close() { onClose?() }

    /// Put the model in a given state without a server.
    ///
    /// The only reason `tools/render-detail.sh` can draw this panel on a Mac in
    /// five seconds: the states worth looking at are POSED, not fished for by
    /// pointing the app at a session that happens to be mid-turn today. Nothing
    /// in the app calls it.
    func pose(detail: DetailSnapshot?, config: BackendsConfig?, form: DetailForm = .empty,
              loading: Bool = false, gone: Bool = false, saving: Bool = false,
              saveError: String? = nil) {
        self.detail = detail
        self.config = config
        self.form = form
        self.loading = loading
        self.gone = gone
        self.saving = saving
        self.saveError = saveError
    }
}

#if canImport(UIKit)
/// The panel, presented over the conversation.
///
/// `bg-black/10` behind it and a 200ms fade-plus-40pt slide, because that is
/// what the web's sheet does — it does NOT slide the whole way in from the
/// edge, it fades and translates 2.5rem (components/ui/sheet.tsx).
@MainActor
final class SessionDetailController: UIViewController {
    private let model: SessionDetailModel
    private var host: UIHostingController<SessionDetailPanel>!
    private let backdrop = UIView()

    init(sessionId: String, scoped: Bool = false) {
        self.model = SessionDetailModel(sessionId: sessionId, scoped: scoped)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
        model.onClose = { [weak self] in self?.dismissPanel() }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        backdrop.backgroundColor = UIColor.black.withAlphaComponent(DetailMetrics.backdropAlpha)
        backdrop.alpha = 0
        backdrop.frame = view.bounds
        backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(backdrop)
        // The overlay closes it. On a phone the panel is full-bleed so this is
        // only reachable during the animation — kept because the web's is.
        backdrop.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(dismissPanel)))

        host = UIHostingController(rootView: SessionDetailPanel(model: model))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        host.view.alpha = 0
        host.view.transform = CGAffineTransform(translationX: DetailMetrics.slideIn, y: 0)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        model.start()
        UIView.animate(withDuration: DetailMetrics.backdropDuration) { self.backdrop.alpha = 1 }
        UIView.animate(withDuration: DetailMetrics.openDuration,
                       delay: 0,
                       options: [.curveEaseInOut]) {
            self.host.view.alpha = 1
            self.host.view.transform = .identity
        }
    }

    @objc private func dismissPanel() {
        model.stop()
        UIView.animate(withDuration: DetailMetrics.openDuration,
                       delay: 0,
                       options: [.curveEaseInOut],
                       animations: {
            self.host.view.alpha = 0
            self.host.view.transform = CGAffineTransform(translationX: DetailMetrics.slideIn, y: 0)
            self.backdrop.alpha = 0
        }, completion: { _ in
            self.presentingViewController?.dismiss(animated: false)
        })
    }
}

#endif

/// The panel plus the confirm it can raise. Split out so `SessionDetailView`
/// stays a pure drawing of the core's answer.
struct SessionDetailPanel: View {
    @ObservedObject var model: SessionDetailModel

    var body: some View {
        SessionDetailView(model: model)
            .ignoresSafeArea(.container, edges: .bottom)
            .alert(model.pendingSwitch?.title ?? "",
                   isPresented: Binding(get: { model.pendingSwitch != nil },
                                        set: { if !$0 { model.cancelSwitch() } })) {
                Button("Cancel", role: .cancel) { model.cancelSwitch() }
                Button(model.pendingSwitch?.confirmLabel ?? "Switch") { model.confirmSwitch() }
            } message: {
                // The emphasis is the core's, not this view's: the web italicises
                // one word — "what is NOT kept" — and losing it here would make
                // the sentence read as the opposite of what it says.
                (model.pendingSwitch?.message ?? []).reduce(Text("")) { acc, p in
                    acc + (p.em ? Text(p.text).italic() : Text(p.text))
                }
            }
    }
}
