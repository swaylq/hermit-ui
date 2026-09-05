import SwiftUI

/// The chat header's right-hand action cluster.
///
/// Which buttons exist and whether they are live is `HeaderActionsCore`, held
/// against the web's own answers by `tools/actions-fixture.sh`. This file is
/// only the pixels and the gestures: `app/chat/page.tsx`'s `h-7 w-7` buttons at
/// `gap-1`, the two-step confirm pill, and the tray that floats leftward over
/// the title on a narrow header.
extension HeaderAction {
    /// The SF Symbol standing in for the web's lucide glyph.
    ///
    /// A MAPPING, not a copy: lucide ships in the page's bundle and SF Symbols
    /// ship with the OS, so the two draw different strokes for the same idea
    /// and pixel-comparing this cluster will always show it. Trading that for a
    /// vendored icon font would cost a third-party dependency on the one
    /// surface where the platform already has an answer everybody recognises.
    var symbol: String {
        switch self {
        case .restore:  return "arrow.up.bin"                  // lucide ArchiveRestore
        case .pureChat: return "eye"                           // Eye
        case .detail:   return "info.circle"                   // Info
        case .find:     return "magnifyingglass"               // Search
        case .compact:  return "rectangle.compress.vertical"   // FoldVertical
        case .restart:  return "arrow.clockwise"               // RotateCw
        case .more:     return "ellipsis"                      // MoreHorizontal
        case .newChat:  return "square.and.pencil"             // SquarePen
        case .terminal: return "terminal"                      // Terminal
        case .delete:   return "trash"                         // Trash2
        }
    }

    /// The web's `aria-label`, verbatim — it is what the simulator test looks
    /// the button up by, so the two surfaces are addressed the same way.
    var label: String {
        switch self {
        case .restore:  return "restore from archive"
        case .pureChat: return "pure chat — start a NEW read-only session with this agent. It can look at files, search the web and add to its own memory, but cannot write, edit, run commands or spawn sub-agents. This conversation is untouched."
        case .detail:   return "session details"
        case .find:     return "find in conversation"
        case .compact:  return "compact — summarize the conversation so the agent's context window shrinks (runs /compact, keeps continuity). THIS is what reduces a large context; restart only reloads the whole history via --resume."
        case .restart:  return "restart — kill this session's tmux pane; the next message respawns claude with --resume (history preserved; context NOT reduced — use compact ⌄ for that)"
        case .more:     return "more actions"
        case .newChat:  return "new chat with this agent"
        case .terminal: return "terminal access"
        case .delete:   return "move this session to the recycle bin"
        }
    }

    /// A short name for the tests and for VoiceOver's rotor, since three of the
    /// labels above are a paragraph of explanation the web puts in a `title`.
    var shortLabel: String {
        switch self {
        case .restore:  return "restore"
        case .pureChat: return "pure chat"
        case .detail:   return "details"
        case .find:     return "find"
        case .compact:  return "compact"
        case .restart:  return "restart"
        case .more:     return "more"
        case .newChat:  return "new chat"
        case .terminal: return "terminal"
        case .delete:   return "delete"
        }
    }
}

enum HeaderActionMetrics {
    /// `h-7 w-7`.
    static let button: CGFloat = 28
    /// `h-4 w-4` inside it.
    static let icon: CGFloat = 16
    /// `h-3.5 w-3.5` — the pill's halves.
    static let pillIcon: CGFloat = 14
    /// `gap-1` between buttons; `gap-0.5` inside the pill.
    static let gap: CGFloat = 4
    static let pillGap: CGFloat = 2
    /// `rounded-md` on a button, `rounded-lg` on the tray, `rounded` in the pill.
    static let radius: CGFloat = 6
    static let trayRadius: CGFloat = 8
    static let pillPartRadius: CGFloat = 4
    /// `px-0.5` around the pill's halves, `px-1.5` inside the confirm half.
    static let pillPadH: CGFloat = 2
    static let confirmPadH: CGFloat = 6
    /// `text-xs font-medium` on the confirm half.
    static let confirmFont: CGFloat = 12
    /// `gap-1` between the confirm half's icon and its words.
    static let confirmGap: CGFloat = 4
    /// The tray's `px-1 py-0.5`, and the `mr-1` between it and the cluster.
    static let trayPadH: CGFloat = 4
    static let trayPadV: CGFloat = 2
    static let trayGap: CGFloat = 4
    /// `translate-x-2` / `scale-95` / `duration-200 ease-out`.
    static let trayShift: CGFloat = 8
    static let trayScale: CGFloat = 0.95
    static let trayDuration: Double = 0.2
}

/// The web's icon button with an inline two-step confirm.
///
/// The state machine — including the 350ms guard that stops a double-tap
/// confirming what it armed — is `Confirm.step`, shared with the web. What is
/// here instead of there is the LAYOUT half of the same decision: the pill is
/// right-aligned so it grows leftward out of the icon's box, and the confirm
/// half is the trailing child, so the pixels the arming tap landed on are the
/// ones that say yes.
struct ConfirmIconButton: View {
    let spec: HeaderActionSpec
    let action: () -> Void
    /// Where the pill's own body colour comes from — `bg-background` in the
    /// header row, and the tray's `bg-popover` inside the tray, which is what
    /// keeps it opaque over the title it floats above.
    var surface: ThemeColor = WebContract.background

    @State private var confirm = ConfirmState.disarmed
    @State private var tick = 0
    @Environment(\.colorScheme) private var scheme

    private var muted: Color { WebContract.mutedForeground.resolve(scheme) }
    private var fg: Color { WebContract.foreground.resolve(scheme) }

    var body: some View {
        Group {
            if confirm.armed { pill } else { idle }
        }
        // The auto-disarm. The reducer re-reads the clock, so a timer that lands
        // early leaves the pill up instead of yanking it out from under a finger
        // — and one that lands late still disarms on its next beat.
        .onReceive(Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()) { _ in
            guard confirm.armed else { return }
            confirm = Confirm.step(confirm, .timeout, now: Date().timeIntervalSince1970 * 1000).state
        }
        .onChange(of: spec.disabled) { _, nowDisabled in
            // A control that just went dead must not keep an armed pill up: the
            // session closed, or its row left the list.
            if nowDisabled { confirm = .disarmed }
        }
    }

    private var idle: some View {
        Button {
            confirm = Confirm.step(confirm, .press, now: Date().timeIntervalSince1970 * 1000).state
        } label: {
            Group {
                if spec.busy {
                    // `<span className="text-xs">…</span>`
                    Text("…").font(.system(size: HeaderActionMetrics.confirmFont))
                } else {
                    Image(systemName: spec.id.symbol)
                        .font(.system(size: HeaderActionMetrics.icon * 0.8, weight: .regular))
                }
            }
            .frame(width: HeaderActionMetrics.button, height: HeaderActionMetrics.button)
            .foregroundStyle(muted)
            // `disabled:opacity-40`
            .opacity(spec.disabled || spec.busy ? 0.4 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(spec.disabled || spec.busy)
        .accessibilityLabel(spec.id.label)
        .accessibilityIdentifier("header.\(spec.id.rawValue)")
    }

    private var pill: some View {
        HStack(spacing: HeaderActionMetrics.pillGap) {
            Button {
                confirm = Confirm.step(confirm, .cancel, now: Date().timeIntervalSince1970 * 1000).state
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: HeaderActionMetrics.pillIcon * 0.8, weight: .regular))
                    .frame(width: HeaderActionMetrics.button, height: HeaderActionMetrics.button)
                    .foregroundStyle(muted)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("cancel")
            .accessibilityIdentifier("header.\(spec.id.rawValue).cancel")

            Button {
                let out = Confirm.step(confirm, .confirm, now: Date().timeIntervalSince1970 * 1000)
                confirm = out.state
                if out.fire { action() }
            } label: {
                HStack(spacing: HeaderActionMetrics.confirmGap) {
                    if let words = spec.confirmLabel {
                        Image(systemName: spec.id.symbol)
                            .font(.system(size: HeaderActionMetrics.pillIcon * 0.8))
                            .foregroundStyle(spec.danger ? WebContract.rose600 : WebContract.amber500)
                        Text(words)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: HeaderActionMetrics.pillIcon * 0.8))
                        Text("confirm")
                    }
                }
                // `whitespace-nowrap`: a labelled confirm wraps to two lines
                // inside the tray, which is narrower than the header row, and a
                // two-line pill is taller than every button beside it.
                .fixedSize()
                .font(.system(size: HeaderActionMetrics.confirmFont, weight: .medium))
                .foregroundStyle(spec.danger ? WebContract.rose600 : fg)
                .padding(.horizontal, HeaderActionMetrics.confirmPadH)
                .frame(height: HeaderActionMetrics.button)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("confirm — \(spec.id.shortLabel)")
            .accessibilityIdentifier("header.\(spec.id.rawValue).confirm")
        }
        .padding(.horizontal, HeaderActionMetrics.pillPadH)
        .background(
            RoundedRectangle(cornerRadius: HeaderActionMetrics.radius)
                .fill(surface.resolve(scheme))
                .overlay(
                    RoundedRectangle(cornerRadius: HeaderActionMetrics.radius)
                        .strokeBorder(WebContract.border.resolve(scheme), lineWidth: 1)
                )
        )
    }
}

/// A plain (one-tap) header button: the toggles, `restore`, `newChat`,
/// `terminal` and `detail`.
struct HeaderIconButton: View {
    let spec: HeaderActionSpec
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    private var lit: Bool { spec.pressed == true }

    var body: some View {
        Button(action: action) {
            Image(systemName: glyph)
                .font(.system(size: HeaderActionMetrics.icon * 0.8, weight: .regular))
                .frame(width: HeaderActionMetrics.button, height: HeaderActionMetrics.button)
                .foregroundStyle(tint)
                .background(
                    RoundedRectangle(cornerRadius: HeaderActionMetrics.radius).fill(fill)
                )
                .opacity(spec.disabled ? 0.5 : 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(spec.disabled)
        .accessibilityLabel(spec.id.label)
        .accessibilityIdentifier("header.\(spec.id.rawValue)")
    }

    /// The tray toggle swaps its glyph when open (`ChevronRight`), which is the
    /// only place in the cluster where the icon reports state rather than names
    /// an action — it points at where the tray went.
    private var glyph: String {
        spec.id == .more && lit ? "chevron.right" : spec.id.symbol
    }

    private var tint: Color {
        if spec.id == .restore {
            // `text-amber-700 dark:text-amber-400`
            return scheme == .dark ? WebContract.amber400 : WebContract.amber700
        }
        return lit ? WebContract.foreground.resolve(scheme) : WebContract.mutedForeground.resolve(scheme)
    }

    private var fill: Color {
        // `bg-amber-500/10` under Restore, `bg-accent` under a lit toggle.
        if spec.id == .restore { return WebContract.amber500.opacity(0.1) }
        return lit ? WebContract.accent.resolve(scheme) : .clear
    }
}

/// The cluster: the persistent buttons on the header row, and — on a header
/// narrower than `HeaderActions.secondaryFoldPx` — the five secondary ones in a
/// tray anchored to the LEFT of it.
struct ChatHeaderActionsView: View {
    let state: HeaderActionState
    /// Runs the action. Confirmed ones only arrive here once confirmed.
    let run: (HeaderAction) -> Void
    /// The members the caller can actually perform. The shared core answers for
    /// the web's full ten; a screen that has nowhere to send one of them says
    /// so here rather than drawing a control that does nothing.
    var available: Set<HeaderAction> = Set(HeaderAction.allCases)
    /// The header's own width, so the fold is decided by the row that has to
    /// hold the buttons rather than by a device idiom.
    var width: CGFloat = 0

    @Environment(\.colorScheme) private var scheme
    /// Measured, because the tray is positioned by its OWN width: its trailing
    /// edge has to land one gap left of the cluster's leading edge, and how far
    /// left that is depends on how many buttons folded into it.
    @State private var trayWidth: CGFloat = 0

    private var specs: [HeaderActionSpec] { HeaderActions.specs(state).filter { available.contains($0.id) } }
    private var folded: Bool { HeaderActions.secondaryFolds(width) }

    var body: some View {
        HStack(spacing: HeaderActionMetrics.gap) {
            ForEach(specs.filter { $0.group == .persistent || !folded }, id: \.id) { spec in
                // The tray toggle is a phone-only control: above the fold the
                // secondary group is inline and there is nothing to open.
                if spec.id != .more || folded {
                    button(spec, surface: WebContract.background)
                }
            }
        }
        // The tray floats over the title rather than taking header width, so
        // opening it costs the row nothing — the same reason the web anchors it
        // to `right-full` instead of putting it in the flow.
        //
        // Mounted only while OPEN, unlike the web's, which keeps it in the DOM
        // at `opacity-0` so CSS has something to transition. SwiftUI has
        // transitions, and the mounted-but-invisible version was a real bug:
        // `.opacity(0)` plus `.allowsHitTesting(false)` plus
        // `.accessibilityHidden(true)` STILL left `header.pureChat` hittable —
        // the simulator test caught it reaching a button nobody could see
        // ("the tray's contents are on the header row with the tray shut").
        .overlay(alignment: .leading) { if folded && state.moreOpen { tray } }
        .animation(.easeOut(duration: HeaderActionMetrics.trayDuration), value: state.moreOpen)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func button(_ spec: HeaderActionSpec, surface: ThemeColor) -> some View {
        if spec.confirm {
            ConfirmIconButton(spec: spec, action: { run(spec.id) }, surface: surface)
        } else {
            HeaderIconButton(spec: spec, action: { run(spec.id) })
        }
    }

    private var tray: some View {
        HStack(spacing: HeaderActionMetrics.trayGap) {
            ForEach(specs.filter { $0.group == .secondary }, id: \.id) { spec in
                button(spec, surface: WebContract.popover)
            }
        }
        .padding(.horizontal, HeaderActionMetrics.trayPadH)
        .padding(.vertical, HeaderActionMetrics.trayPadV)
        .background(
            RoundedRectangle(cornerRadius: HeaderActionMetrics.trayRadius)
                // `bg-popover/95` over a `backdrop-blur-sm`. The blur is
                // dropped: it exists on the web so the title shows through
                // faintly, and `.ultraThinMaterial` under a 95% fill is
                // invisible while costing an offscreen pass on every frame of
                // the slide.
                .fill(WebContract.popover.resolve(scheme).opacity(0.95))
                .overlay(
                    RoundedRectangle(cornerRadius: HeaderActionMetrics.trayRadius)
                        .strokeBorder(WebContract.border.resolve(scheme), lineWidth: 1)
                )
                // `shadow-lg`
                .shadow(color: .black.opacity(scheme == .dark ? 0.5 : 0.1),
                        radius: 7.5, x: 0, y: 5)
        )
        .background {
            GeometryReader { geo in
                Color.clear.onAppear { trayWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, w in trayWidth = w }
            }
        }
        // `right-full mr-1`: the overlay's `.leading` alignment puts the tray's
        // left edge on the cluster's left edge, and this walks it back by its
        // own width plus one gap, so its RIGHT edge lands one gap left of the
        // cluster.
        //
        // An `alignmentGuide(.leading)` says the same thing in one line and was
        // the first attempt; it had no effect through the overlay and the tray
        // drew on top of the three persistent buttons instead of beside them
        // (shots/timeline-header-light.png, first pass). Measuring is longer
        // and it is visibly right.
        .offset(x: -(trayWidth + HeaderActionMetrics.gap))
        // `origin-right ... translate-x-2 scale-95`: it grows out of the
        // toggle, not out of its own middle.
        .transition(.scale(scale: HeaderActionMetrics.trayScale, anchor: .trailing)
            .combined(with: .offset(x: HeaderActionMetrics.trayShift))
            .combined(with: .opacity))
    }
}
