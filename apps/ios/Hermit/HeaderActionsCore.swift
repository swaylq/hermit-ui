import Foundation

/// The chat header's right-hand action cluster, as data.
///
/// A port of `components/chat/header-actions-core.ts`, which the web's own
/// `app/chat/page.tsx` and `confirm-icon-button.tsx` call — so
/// `tools/actions-fixture.sh` compares two implementations rather than an
/// implementation against someone's reading of the JSX.
///
/// Nothing here knows about SwiftUI, SF Symbols or tRPC. The identifiers are
/// semantic (`.delete`, not "trash"), because the two platforms draw different
/// glyphs for the same action and a shared table cannot hold either one.
enum HeaderAction: String, Codable, CaseIterable, Sendable {
    case restore, pureChat, detail, find, compact, restart, more, newChat, terminal, delete
}

/// `persistent` is on the header row at every width; `secondary` is the group
/// that folds into the ⋯ tray below `HeaderActions.secondaryFoldPx`.
enum HeaderActionGroup: String, Codable, Sendable {
    case persistent, secondary
}

struct HeaderActionSpec: Equatable, Codable, Sendable {
    var id: HeaderAction
    var group: HeaderActionGroup
    /// Two-step: the icon arms a pill, and the pill's trailing half fires.
    var confirm: Bool
    /// What the armed half says. Nil → the generic "confirm".
    var confirmLabel: String?
    var danger: Bool
    var disabled: Bool
    /// A request of this kind is in flight — the idle icon becomes "…".
    var busy: Bool
    /// Toggles only (`find`, `more`): drawn lit while true.
    var pressed: Bool?
}

/// Everything the cluster's shape depends on. Deliberately not `SessionMeta`:
/// four fields off the session plus six flags the screen owns, so the fixture
/// can state a case in one line and the view has nothing left to decide.
struct HeaderActionState: Equatable, Sendable {
    /// Nil until the session is known. Every "disabled" that mentions it is the
    /// same judgement: an action whose target has not loaded cannot fire.
    var session: Session?
    /// A share link: no machine procedures, so no terminal.
    var scoped: Bool = false
    var creatingChat: Bool = false
    var deleting: Bool = false
    var restarting: Bool = false
    var reopening: Bool = false
    var findOpen: Bool = false
    var moreOpen: Bool = false
    /// `hasTmuxPane(session.runtime)`, passed in so this type stays label-free.
    var hasTmuxPane: Bool = true

    struct Session: Equatable, Sendable {
        var agentName: String?
        var closed: Bool = false
        var restartRequested: Bool = false

        init(agentName: String? = nil, closed: Bool = false, restartRequested: Bool = false) {
            self.agentName = agentName
            self.closed = closed
            self.restartRequested = restartRequested
        }
    }

    /// Reads the three fields the cluster cares about off a loaded session row.
    static func of(meta: SessionMeta?, scoped: Bool = false) -> HeaderActionState {
        guard let meta else { return HeaderActionState(session: nil, scoped: scoped) }
        return HeaderActionState(
            session: Session(agentName: meta.agentName.isEmpty ? nil : meta.agentName,
                             closed: meta.closedAt != nil,
                             restartRequested: meta.restartRequestedAt != nil),
            scoped: scoped,
            hasTmuxPane: WebLabels.hasTmuxPane(meta.runtime)
        )
    }
}

enum HeaderActions {
    /// The width at which the secondary group stops folding. A CONTAINER query
    /// on the chat column on the web (`@min-[40rem]`), not the viewport — which
    /// on a phone is the same number and on an iPad is not.
    static let secondaryFoldPx: CGFloat = 640

    static func secondaryFolds(_ headerWidthPx: CGFloat) -> Bool {
        headerWidthPx < secondaryFoldPx
    }

    /// The cluster in the web's DOM order: the persistent leading `restore`,
    /// then the five that fold, then the tray toggle and the trailing three.
    ///
    /// Actions that do not apply are ABSENT, not disabled — `restore` on a live
    /// session and `terminal` on a paneless runtime are not greyed out on the
    /// web either, they are not rendered. A view therefore never re-derives
    /// visibility; it draws what it is handed.
    static func specs(_ s: HeaderActionState) -> [HeaderActionSpec] {
        let session = s.session
        let closed = session?.closed ?? false
        var out: [HeaderActionSpec] = []

        // The way out of an archived chat. Persistent (never in the tray) and
        // tinted, because for a closed session it is the only action that does
        // anything — everything else is disabled and the composer just says
        // "session is closed".
        if closed {
            out.append(HeaderActionSpec(id: .restore, group: .persistent, confirm: false,
                                        confirmLabel: nil, danger: false,
                                        disabled: s.reopening, busy: s.reopening, pressed: nil))
        }

        out.append(HeaderActionSpec(id: .pureChat, group: .secondary, confirm: true,
                                    confirmLabel: "pure chat", danger: false,
                                    disabled: (session?.agentName ?? "").isEmpty,
                                    busy: s.creatingChat, pressed: nil))
        out.append(HeaderActionSpec(id: .detail, group: .secondary, confirm: false,
                                    confirmLabel: nil, danger: false,
                                    disabled: false, busy: false, pressed: nil))
        out.append(HeaderActionSpec(id: .find, group: .secondary, confirm: false,
                                    confirmLabel: nil, danger: false,
                                    disabled: false, busy: false, pressed: s.findOpen))
        // compact SENDS a message, so a closed session cannot run it — unlike
        // restart, which only kills a pane and is merely pointless there.
        out.append(HeaderActionSpec(id: .compact, group: .secondary, confirm: true,
                                    confirmLabel: nil, danger: false,
                                    disabled: session == nil || closed, busy: false, pressed: nil))
        out.append(HeaderActionSpec(id: .restart, group: .secondary, confirm: true,
                                    confirmLabel: nil, danger: false,
                                    disabled: session == nil,
                                    busy: (session?.restartRequested ?? false) || s.restarting,
                                    pressed: nil))

        out.append(HeaderActionSpec(id: .more, group: .persistent, confirm: false,
                                    confirmLabel: nil, danger: false,
                                    disabled: false, busy: false, pressed: s.moreOpen))
        out.append(HeaderActionSpec(id: .newChat, group: .persistent, confirm: false,
                                    confirmLabel: nil, danger: false,
                                    disabled: (session?.agentName ?? "").isEmpty || s.creatingChat,
                                    busy: false, pressed: nil))
        // pi and codex sessions run as child processes with no tmux pane — the
        // terminal would attach to a pane that does not exist.
        if !s.scoped && s.hasTmuxPane {
            out.append(HeaderActionSpec(id: .terminal, group: .persistent, confirm: false,
                                        confirmLabel: nil, danger: false,
                                        disabled: false, busy: false, pressed: nil))
        }
        out.append(HeaderActionSpec(id: .delete, group: .persistent, confirm: true,
                                    confirmLabel: nil, danger: true,
                                    disabled: session == nil, busy: s.deleting, pressed: nil))

        return out
    }

    static func ids(_ s: HeaderActionState) -> [HeaderAction] { specs(s).map(\.id) }
}

// MARK: - The two-step confirm

/// How long the armed pill waits before it will accept a tap.
///
/// The tap that ARMS and the tap that confirms land on the same pixels (the
/// pill grows leftward from a right-anchored icon and the confirm half is drawn
/// LAST, over them), so with no dead time a double-tap would confirm a
/// destructive action the user only pointed at once. 350ms is just past iOS's
/// ~300ms double-tap window. A tap inside it is ignored and the pill STAYS
/// ARMED, so the next tap still works; nothing is silently swallowed.
///
/// Both constants come from the web file; a fixture row asserts the numbers so
/// the two cannot drift apart quietly.
enum ConfirmTiming {
    static let armGuardMs: Double = 350
    /// How long the pill stays armed with no input. Long enough to read on a
    /// phone, short enough that a stray confirm can't be collected minutes later.
    static let autoDisarmMs: Double = 5_000
}

struct ConfirmState: Equatable, Sendable {
    var armed: Bool
    /// Milliseconds since the epoch, matching the web's `Date.now()`.
    var armedAt: Double

    static let disarmed = ConfirmState(armed: false, armedAt: 0)

    static func armed(at now: Double) -> ConfirmState { ConfirmState(armed: true, armedAt: now) }
}

enum ConfirmEvent: String, Codable, Sendable {
    case press, cancel, confirm, timeout
}

struct ConfirmOutcome: Equatable, Sendable {
    var state: ConfirmState
    /// True exactly on the step that should run the action.
    var fire: Bool
}

enum Confirm {
    /// Has the arming tap's bounce window passed?
    static func settled(_ state: ConfirmState, now: Double) -> Bool {
        state.armed && now - state.armedAt >= ConfirmTiming.armGuardMs
    }

    /// ORDER IS LOAD-BEARING, and it is encoded here as the guard rather than in
    /// the layout: cancel and confirm arrive from the same pixels, so an
    /// unguarded second tap in the same spot used to cancel what the first
    /// armed, and delete looked broken ("点击删除了还在", 2026-08-30).
    static func step(_ state: ConfirmState, _ event: ConfirmEvent, now: Double) -> ConfirmOutcome {
        switch event {
        case .press:
            // Re-pressing an armed control re-arms rather than toggling off: the
            // idle icon is not on screen to press while the pill covers it.
            return ConfirmOutcome(state: .armed(at: now), fire: false)
        case .cancel:
            guard state.armed else { return ConfirmOutcome(state: state, fire: false) }
            return settled(state, now: now)
                ? ConfirmOutcome(state: .disarmed, fire: false)
                : ConfirmOutcome(state: state, fire: false)
        case .confirm:
            guard state.armed else { return ConfirmOutcome(state: state, fire: false) }
            return settled(state, now: now)
                ? ConfirmOutcome(state: .disarmed, fire: true)
                : ConfirmOutcome(state: state, fire: false)
        case .timeout:
            guard state.armed else { return ConfirmOutcome(state: state, fire: false) }
            return now - state.armedAt >= ConfirmTiming.autoDisarmMs
                ? ConfirmOutcome(state: .disarmed, fire: false)
                : ConfirmOutcome(state: state, fire: false)
        }
    }
}
