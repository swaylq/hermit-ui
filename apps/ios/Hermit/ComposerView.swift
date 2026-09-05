import SwiftUI

/// The chat composer, drawn to match `components/chat/composer.tsx`.
///
/// ## What is here, and what is not
///
/// The half a conversation cannot happen without: a box that grows, a draft that
/// survives the app being killed, a send circle, the Stop pill beside it, and —
/// since round 8 — the `+` that attaches an image or a file, with its chips
/// above the box.
///
/// Since round 9 the slot right of the box holds the microphone while the box is
/// empty and the ✕ once it is not — the web's own rule, in `HoldCore.micSlot` —
/// so the send circle finally sits where the web puts it in both states. The
/// press-and-hold that goes with it is a transparent layer over the field, and
/// the gesture it starts is decided by the HOST: the overlay it draws is
/// full-screen, and this view is only as tall as the bottom of the screen.
///
/// ## Pure SwiftUI, on purpose
///
/// No UIKit anywhere in this file, which is what lets `tools/render-composer.sh`
/// draw it on the Mac in two seconds instead of booting a simulator. That is the
/// same bargain `ChatHeaderView` and `TimelineRowView` take, and round 5 is why
/// it is worth taking: the `max-w-[9rem]` mistake there passed six assertions and
/// was only ever visible in a picture.
enum ComposerMetrics {
    /// `px-3 pb-3 pt-1` on the column that holds the row. The web's `max-w-3xl`
    /// is centred and never binds at phone widths.
    static let padH: CGFloat = 12
    static let padTop: CGFloat = 4
    static let padBottom: CGFloat = 12

    /// `rounded-[26px] border px-2 py-2`, `gap-1.5` between the row's items.
    static let radius: CGFloat = 26
    static let boxPadH: CGFloat = 8
    static let boxPadV: CGFloat = 8
    static let gap: CGFloat = 6
    /// A CSS `1px` border, drawn as one point the way the rest of this app does.
    static let hairline: CGFloat = 1

    /// `h-9 w-9` on each round control, `h-5 w-5` on the glyph inside it.
    static let control: CGFloat = 36
    static let icon: CGFloat = 20

    /// `text-base sm:text-[15px]` — the phone takes the first, 16px. Over
    /// `leading-relaxed`, which is 1.625, so a 26px line box.
    ///
    /// 16 and not 15 also happens to be the size below which mobile Safari zooms
    /// a focused input; that is a coincidence here (this is not Safari) but it is
    /// why the web picked the pair.
    static let font: CGFloat = 16
    static let line: CGFloat = 26
    /// `py-1.5` inside the textarea itself.
    static let fieldPadV: CGFloat = 6
    /// `min-h-[28px]` on the textarea. Recorded because it is in the CSS, and
    /// noted because it never binds: one line is already taller.
    static let fieldMinHeight: CGFloat = 28
    /// What one line of the web's textarea actually measures — the 26px line box
    /// plus `py-1.5` top and bottom, `box-sizing: border-box` — and therefore
    /// what the whole row is as tall as, because 38 beats the 36pt buttons.
    ///
    /// This has to be stated as a NUMBER rather than left to the font, and the
    /// first version of this file left it to the font: SwiftUI sizes a line from
    /// the system font's own metrics (about 19.1pt at size 16), so the row came
    /// out 54pt against the web's 56. Two points, on the largest control on the
    /// screen, invisible in every assertion and plain in `pixel-probe`.
    static let fieldOneLine: CGFloat = line + fieldPadV * 2
    /// The leading a wrapped draft needs to land on the web's 26px line box.
    /// Same arithmetic — and the same caveat — as `TimelineRowView.webLine`:
    /// SwiftUI can set the gap BETWEEN lines, not the height of the first one.
    static let fieldLeading: CGFloat = max(0, line - font * 1.2)
    /// `max-h-[360px]` on a 26px line box: 13.8 lines, so thirteen whole ones,
    /// and the field scrolls after that.
    static let maxLines = 13

    /// The Stop pill: `mr-1 h-9 px-2.5`, `gap-1.5`, `text-xs font-medium`, and a
    /// `h-2.5 w-2.5 rounded-[2px]` square for the glyph.
    static let pillPadH: CGFloat = 10
    static let pillMarginRight: CGFloat = 4
    static let pillGap: CGFloat = 6
    static let pillFont: CGFloat = 12
    static let pillSquare: CGFloat = 10
    static let pillSquareRadius: CGFloat = 2

    /// `ARM_MS` in composer.tsx: a turn can start while a finger is already
    /// moving toward this corner, so the pill ignores taps that arrive before it
    /// has been on screen long enough to have been aimed at.
    static let pillArm: TimeInterval = 0.4

    /// The amber notice strip above the row: `mb-2 rounded-md border px-2.5
    /// py-1.5 text-[12px]`.
    static let noticeFont: CGFloat = 12
    static let noticePadH: CGFloat = 10
    static let noticePadV: CGFloat = 6
    static let noticeRadius: CGFloat = 6
    static let noticeGap: CGFloat = 8
}

/// Everything the composer draws that is not the draft itself.
struct ComposerModel: Equatable {
    /// `composerPlaceholder(...)` — the ladder, already resolved.
    var placeholder: String
    /// `composerCanSend(...)` — whether the circle is live.
    var canSend: Bool
    /// A send is in flight; the circle shows `…` instead of the arrow.
    var sending: Bool
    /// `stopPill(...).show`.
    var showStop: Bool
    /// `cancelTurn` is in flight.
    var stopping: Bool
    /// The session is closed: the box will not take text.
    var disabled: Bool
    /// An interaction card upstream is waiting on a tap. It greys the `+` on the
    /// web as well as the box, which is why it is carried here and not only
    /// resolved into `placeholder`/`canSend` upstream.
    ///
    /// Fed `false` today: interaction cards are M4's last line and the native
    /// timeline cannot draw one yet. The field exists so that when they land,
    /// the `+` is already wired to them.
    var awaitingInput: Bool = false
    /// A dictation run is live: the mic is lit and the box is being written into
    /// by something that is not the keyboard.
    var dictating: Bool = false
    /// The permission ask is in flight — the mic spins and refuses taps.
    var micArming: Bool = false
    /// Can this screen dictate at all? False with no machine key, which is the
    /// web's `onDictate === undefined`, and the difference between an empty slot
    /// and a mic that would only ever fail.
    var canDictate: Bool = false
    /// A press-and-hold is live right now. Keeps the press layer mounted even
    /// though every other input says it should be gone — see `HoldCore.pressLayer`.
    var holdLive: Bool = false
    /// The amber strip above the row — why the last send did not land, mostly.
    var notice: String?
    /// Extra room under the row: the home indicator's safe area while the
    /// keyboard is down, nothing while it is up.
    ///
    /// `max()` against `padBottom`, never stacked on top of it — `pwa-pb-safe`
    /// on the web is `padding-bottom: max(0.75rem, env(safe-area-inset-bottom))`,
    /// so the box sits snug above the indicator instead of floating on an empty
    /// band. The host supplies the number because only it can see the keyboard.
    var bottomInset: CGFloat = 0
}

/// `text-amber-700 dark:text-amber-400` and its `border-amber-500/30
/// bg-amber-500/10` frame. Amber-500 and amber-700 are not in `WebContract`'s
/// palette (nothing else on a native screen draws them yet); when a second
/// screen needs them they go through `gen-ios-contract` like the rest, and these
/// two lines go away.
private enum ComposerAmber {
    /// `amber-500` — oklch(76.9% 0.188 70.08)
    static let five = Color(.displayP3, red: 0.9694, green: 0.6199, blue: 0.0670)
    /// `amber-700` — oklch(55.5% 0.163 48.998)
    static let seven = Color(.displayP3, red: 0.7168, green: 0.3352, blue: 0.0356)
}

/// The two values the composer redraws on, in one object.
///
/// An `ObservableObject` and not a plain value with a `Binding`: the draft
/// changes on every keystroke and the model changes on every stream frame, and a
/// hosting controller only redraws a value view when its `rootView` is
/// reassigned. Publishing instead means the box never lags a character behind
/// the keyboard — and it means the timeline can update the Stop pill without
/// rebuilding the view around a text field that currently has the caret.
final class ComposerState: ObservableObject {
    @Published var draft: String
    @Published var model: ComposerModel
    /// The chips above the box. Published on the same clock as the draft
    /// because they move together: a paste puts a chip up and an upload
    /// finishing lights the send circle, both mid-keystroke.
    /// The waiting-dispatch strip above the row. Here rather than in its own
    /// object because it is published on the same clock as everything else the
    /// bottom of this screen shows, and because the two are one unit to the
    /// reader: a message leaves the box and appears in the strip.
    @Published var attachments: [ComposerAttachment]
    @Published var queue: QueueBarModel
    /// Bumped to put the caret in the box. A counter and not a `Bool` because the
    /// request has to fire again after the field has been focused and blurred —
    /// tapping an empty box twice is two requests, and a flag would only be one.
    ///
    /// The press layer needs this: it takes the touch that used to reach the
    /// field, so it owes a tap back, and `@FocusState` is not something a view
    /// controller can reach into.
    @Published var focusRequest = 0

    init(draft: String = "", model: ComposerModel,
         attachments: [ComposerAttachment] = [],
         queue: QueueBarModel = QueueBarModel()) {
        self.draft = draft
        self.model = model
        self.attachments = attachments
        self.queue = queue
    }
}

struct ComposerView: View {
    @Environment(\.colorScheme) private var scheme

    @ObservedObject var state: ComposerState
    var onSend: () -> Void
    var onStop: () -> Void
    var onClear: () -> Void
    var onDismissNotice: () -> Void
    /// The `+`. The host owns the picker, because a picker is a view controller.
    var onAttach: () -> Void
    /// A chip's `×`.
    var onRemoveAttachment: (String) -> Void
    /// Every keystroke. The web persists the draft on exactly the same trigger
    /// (`useEffect(… , [sessionId, draft])`), because a draft that is only
    /// written on blur is a draft the app loses when iOS kills it.
    var onDraftChange: (String) -> Void
    /// The mic button. One button, two meanings — start a hands-free run, or end
    /// the one that is running — and the host decides which from `dictating`,
    /// exactly as the web's `onClick` does.
    var onMic: () -> Void = {}
    /// The press layer, in WINDOW coordinates. Called on touch-down and on every
    /// move; the host tells the two apart (it knows whether a gesture is live)
    /// and owns every threshold. Both points come straight from the gesture, so
    /// nothing here has to remember where the finger started.
    var onHoldChanged: (CGPoint, CGPoint) -> Void = { _, _ in }
    var onHoldEnded: (CGPoint, CGPoint) -> Void = { _, _ in }

    private var model: ComposerModel { state.model }

    /// When the Stop pill appeared. A tap before `pillArm` is a finger that was
    /// already travelling when the turn started, not a decision to kill it.
    @State private var stopShownAt: Date?
    @FocusState private var focused: Bool
    /// "This is being drawn into a PNG, not onto a screen" — see SessionRowView,
    /// which introduced the flag for `animate-pulse`. The composer needs it for a
    /// harder reason: `ImageRenderer` cannot draw a `TextField` at all. It puts a
    /// yellow "unavailable" plate in its place, which is what the first run of
    /// `render-composer.sh` produced — the frame, the pill and the circle all
    /// correct, and the one thing a composer is for replaced by a warning label.
    @Environment(\.hermitStillFrame) private var stillFrame

    private var fg: Color { WebContract.foreground.resolve(scheme) }
    private var muted: Color { WebContract.mutedForeground.resolve(scheme) }
    private var background: Color { WebContract.background.resolve(scheme) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let notice = model.notice {
                noticeStrip(notice)
                    .padding(.bottom, ComposerMetrics.noticeGap)
            }
            // Above the box, below the notice — the web's order, and the one
            // that matters: "Skipped 3 images" has to sit above the chips it is
            // explaining, not below them.
            if !state.attachments.isEmpty {
                AttachmentStripView(attachments: state.attachments, onRemove: onRemoveAttachment)
            }
            row
        }
        .padding(.horizontal, ComposerMetrics.padH)
        .padding(.top, ComposerMetrics.padTop)
        .padding(.bottom, max(ComposerMetrics.padBottom, model.bottomInset))
        .frame(maxWidth: .infinity)
        // `shrink-0 bg-background` on the form: the composer is opaque, so the
        // conversation scrolling under it does not show through.
        .background(background)
        .onChange(of: model.showStop) { _, showing in
            stopShownAt = showing ? Date() : nil
        }
        .onAppear { if model.showStop { stopShownAt = Date() } }
        .onChange(of: state.draft) { _, value in onDraftChange(value) }
        .onChange(of: state.focusRequest) { _, _ in focused = true }
    }

    // MARK: - The row

    /// `flex items-end gap-1.5 rounded-[26px] border bg-background px-2 py-2`.
    ///
    /// `items-end` is what keeps the send circle on the bottom line as the box
    /// grows upward, rather than drifting to the middle of a six-line draft.
    private var row: some View {
        HStack(alignment: .bottom, spacing: ComposerMetrics.gap) {
            attachButton
            field
            trailingSlot
            if model.showStop {
                stopPill
                    .padding(.trailing, ComposerMetrics.pillMarginRight - ComposerMetrics.gap)
            }
            sendButton
        }
        // `px-2 py-2` PLUS the border. CSS padding is measured from the inside
        // of the border and `box-sizing: border-box` adds the border to the
        // element's height, so the web's row is 1 + 8 + 38 + 8 + 1 = 56px tall.
        // SwiftUI's `.strokeBorder` is an overlay: it paints inside the bounds
        // and contributes nothing to them, so without this the row came out 54 —
        // two points short, on the largest control on the screen, and visible
        // only in `pixel-probe`.
        .padding(.horizontal, ComposerMetrics.boxPadH + ComposerMetrics.hairline)
        .padding(.vertical, ComposerMetrics.boxPadV + ComposerMetrics.hairline)
        .background(
            RoundedRectangle(cornerRadius: ComposerMetrics.radius, style: .continuous)
                .fill(background)
        )
        .overlay(
            RoundedRectangle(cornerRadius: ComposerMetrics.radius, style: .continuous)
                // `focus-within:border-foreground/40`, and `opacity-60` over the
                // whole row when the session is closed.
                .strokeBorder(focused ? fg.opacity(0.4) : WebContract.border.resolve(scheme),
                              lineWidth: ComposerMetrics.hairline)
        )
        .opacity(model.disabled ? 0.6 : 1)
    }

    /// The textarea. `TextField(axis: .vertical)` rather than a `TextEditor`
    /// because it self-sizes from one line up to a cap, which is exactly what
    /// the web's `el.style.height = min(scrollHeight, 360)` does by hand — and
    /// because it has no text-container inset to fight, so `py-1.5` lands where
    /// the CSS puts it.
    ///
    /// Return inserts a newline and does NOT send. That is the web's own rule on
    /// a touch device (`if (isTouchPrimary()) return;` in its keydown handler),
    /// and it is also the only behaviour that survives an IME: for anyone typing
    /// 拼音, Return is how a candidate is chosen.
    @ViewBuilder private var field: some View {
        Group {
            if stillFrame {
                // A still: the same string at the same size in the same box,
                // drawn by something ImageRenderer can actually draw. It is not
                // the real control and the picture is not proof that the control
                // lays out identically — but an empty plate is proof of nothing
                // at all, and everything AROUND the field (the row's height, where
                // the circle sits, how far the box grows) is the same view either
                // way.
                Text(state.draft.isEmpty ? model.placeholder : state.draft)
                    .font(.system(size: ComposerMetrics.font))
                    .foregroundStyle(state.draft.isEmpty ? muted.opacity(0.7) : fg)
                    .lineLimit(ComposerMetrics.maxLines)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                TextField("", text: $state.draft, prompt: placeholderText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...ComposerMetrics.maxLines)
                    .font(.system(size: ComposerMetrics.font))
                    .foregroundStyle(fg)
                    .tint(fg)
                    .focused($focused)
                    .disabled(model.disabled)
                    .accessibilityIdentifier("composer.field")
            }
        }
        .lineSpacing(ComposerMetrics.fieldLeading)
        .padding(.vertical, ComposerMetrics.fieldPadV)
        .frame(minHeight: ComposerMetrics.fieldOneLine, alignment: .bottom)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { if pressLayer { holdLayer } }
    }

    /// Is the press layer over the field right now? Every input but `focused`
    /// comes from the host; that one is the one the host cannot see.
    private var pressLayer: Bool {
        HoldCore.pressLayer(touch: true,
                            canDictate: model.canDictate,
                            disabled: model.disabled,
                            awaitingInput: model.awaitingInput,
                            dictating: model.dictating,
                            draftLength: state.draft.count,
                            focused: focused,
                            gestureLive: model.holdLive)
    }

    /// Press and hold to talk — WeChat's idiom, on the "Ask anything" box.
    ///
    /// A transparent layer over the field and NOT the field itself, for the same
    /// reason the web uses a plain div rather than the textarea: a long press on
    /// a real text field belongs to the platform. UIKit answers it with the
    /// magnifier and an edit menu, and there is no reliable way to call that off
    /// once it has started. A plain layer has no such behaviour, so it takes the
    /// hold and hands a TAP straight back — which focuses the field, which is all
    /// tapping an empty box ever did.
    ///
    /// `minimumDistance: 0` so the very first touch reports; everything the
    /// gesture decides from — 260ms, 10 points of travel, 64 points of slide —
    /// is `HoldCore`, in the host, where the hit boxes are.
    private var holdLayer: some View {
        Color.clear
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .onChanged { v in onHoldChanged(v.startLocation, v.location) }
                    .onEnded { v in onHoldEnded(v.startLocation, v.location) }
            )
            .accessibilityIdentifier("composer.hold")
    }

    /// `placeholder:text-muted-foreground/70`.
    private var placeholderText: Text {
        Text(model.placeholder)
            .font(.system(size: ComposerMetrics.font))
            .foregroundColor(muted.opacity(0.7))
    }

    /// `+` — one affordance for images and files alike, exactly as the web has
    /// one `<input type="file">` and no menu of kinds. `pb-0.5` on the wrapper
    /// is why it sits two points above the bottom of the row.
    ///
    /// The glyph is drawn rather than borrowed: see `AttachMetrics.plusArm` for
    /// why an SF Symbol is the wrong size here.
    private var attachButton: some View {
        Button(action: onAttach) {
            ZStack {
                Capsule()
                    .frame(width: AttachMetrics.plusArm, height: AttachMetrics.plusStroke)
                Capsule()
                    .frame(width: AttachMetrics.plusStroke, height: AttachMetrics.plusArm)
            }
            .foregroundStyle(muted)
            .frame(width: ComposerMetrics.control, height: ComposerMetrics.control)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(model.disabled || model.awaitingInput)
        // `disabled:opacity-40`.
        .opacity(model.disabled || model.awaitingInput ? 0.4 : 1)
        .padding(.bottom, AttachMetrics.plusBottomPad)
        .accessibilityLabel("attach image or file")
        .accessibilityIdentifier("composer.attach")
    }

    /// One slot between the box and the send circle, and `HoldCore.micSlot`
    /// decides what is in it: the microphone while the box is empty (or while a
    /// run is live, however much has been dictated into it), the ✕ once there is
    /// a draft, and nothing at all only when there is nothing to say.
    @ViewBuilder private var trailingSlot: some View {
        switch HoldCore.micSlot(dictating: model.dictating,
                                draftLength: state.draft.count,
                                canDictate: model.canDictate,
                                disabled: model.disabled,
                                awaitingInput: model.awaitingInput,
                                micArming: model.micArming) {
        case let .mic(listening, spinner, disabled):
            micButton(listening: listening, spinner: spinner, disabled: disabled)
        case .clear:
            clearButton
        case .none:
            EmptyView()
        }
    }

    /// The microphone. A TOGGLE — the same pixels start the run and end it — and
    /// while it is listening it is LIT rather than swapped for some other glyph:
    /// the button you pressed is the button you press again, and the only thing
    /// that changed is that it is on. That is also the whole status display for a
    /// hands-free run; the words themselves are the rest of it.
    private func micButton(listening: Bool, spinner: Bool, disabled: Bool) -> some View {
        let lit = scheme == .dark ? WebContract.rose400 : WebContract.rose500
        return Button(action: onMic) {
            ZStack {
                // Breathing halo. Deliberately not a ping that scales to twice the
                // button — that would wash over the send circle beside it.
                if listening {
                    Circle()
                        .fill(lit.opacity(scheme == .dark ? 0.2 : 0.15))
                        .modifier(HermitPulse())
                }
                if spinner {
                    ProgressView()
                        .controlSize(.small)
                        .tint(muted)
                } else {
                    Image(systemName: "mic")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(listening ? lit : muted)
                }
            }
            .frame(width: ComposerMetrics.control, height: ComposerMetrics.control)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.6 : 1)
        .accessibilityLabel(HoldCore.micSlotLabel(dictating: listening))
        .accessibilityIdentifier("composer.mic")
    }

    /// The `✕` that empties the box.
    private var clearButton: some View {
        Button(action: onClear) {
            Image(systemName: "xmark")
                .font(.system(size: 15, weight: .medium))
                .frame(width: ComposerMetrics.control, height: ComposerMetrics.control)
                .foregroundStyle(muted)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("clear draft")
        .accessibilityIdentifier("composer.clear")
    }

    /// `h-9 rounded-full border border-rose-500/40 px-2.5 text-xs font-medium
    /// text-rose-600 dark:text-rose-400`, with a filled square for the glyph.
    ///
    /// Labelled, and never styled like the circle beside it. It once lived in the
    /// send button's own slot with identical styling, so while a turn ran the
    /// most-tapped pixels in the app quietly changed meaning from "send" to "kill
    /// the turn". See docs/composer-stop-misfire.md.
    private var stopPill: some View {
        let rose = scheme == .dark ? WebContract.rose400 : WebContract.rose600
        return Button {
            // The arm delay. Written as a guard inside the action rather than as
            // `.disabled`, exactly as the web writes it: a disabled button also
            // stops the tap from being swallowed, and the point is to swallow it.
            if let shown = stopShownAt, Date().timeIntervalSince(shown) < ComposerMetrics.pillArm { return }
            onStop()
        } label: {
            HStack(spacing: ComposerMetrics.pillGap) {
                RoundedRectangle(cornerRadius: ComposerMetrics.pillSquareRadius, style: .continuous)
                    .fill(rose)
                    .frame(width: ComposerMetrics.pillSquare, height: ComposerMetrics.pillSquare)
                Text(model.stopping ? "stopping…" : "Stop")
                    .font(.system(size: ComposerMetrics.pillFont, weight: .medium))
                    .foregroundStyle(rose)
                    .fixedSize()
            }
            .padding(.horizontal, ComposerMetrics.pillPadH)
            .frame(height: ComposerMetrics.control)
            .overlay(
                Capsule().strokeBorder(WebContract.rose500.opacity(0.4),
                                       lineWidth: ComposerMetrics.hairline)
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(model.stopping)
        .opacity(model.stopping ? 0.6 : 1)
        .accessibilityLabel(model.stopping ? "stopping" : "stop this turn")
    }

    /// One button, one meaning, always in the same place: this circle sends.
    /// `bg-foreground text-background` when it is live, `bg-muted
    /// text-muted-foreground/40` when it is not.
    private var sendButton: some View {
        Button(action: onSend) {
            ZStack {
                Circle().fill(model.canSend ? fg : WebContract.muted.resolve(scheme))
                if model.sending {
                    Text("…")
                        .font(.system(size: 14))
                        .foregroundStyle(model.canSend ? background : muted.opacity(0.4))
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: ComposerMetrics.icon, weight: .medium))
                        .foregroundStyle(model.canSend ? background : muted.opacity(0.4))
                }
            }
            .frame(width: ComposerMetrics.control, height: ComposerMetrics.control)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!model.canSend)
        .accessibilityLabel(model.showStop ? "queue message" : "send")
        .accessibilityIdentifier("composer.send")
    }

    // MARK: - The notice

    /// Why the last send did not land. Tapping it dismisses, which is the web's
    /// behaviour — the whole strip is the button there too.
    private func noticeStrip(_ text: String) -> some View {
        Button(action: onDismissNotice) {
            HStack(spacing: ComposerMetrics.pillGap) {
                Text(text)
                    .font(.system(size: ComposerMetrics.noticeFont))
                    .foregroundStyle(scheme == .dark ? WebContract.amber400 : ComposerAmber.seven)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle((scheme == .dark ? WebContract.amber400 : ComposerAmber.seven).opacity(0.6))
            }
            .padding(.horizontal, ComposerMetrics.noticePadH)
            .padding(.vertical, ComposerMetrics.noticePadV)
            .background(
                RoundedRectangle(cornerRadius: ComposerMetrics.noticeRadius, style: .continuous)
                    .fill(ComposerAmber.five.opacity(0.1))
            )
            .overlay(
                RoundedRectangle(cornerRadius: ComposerMetrics.noticeRadius, style: .continuous)
                    .strokeBorder(ComposerAmber.five.opacity(0.3), lineWidth: ComposerMetrics.hairline)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("dismiss")
    }
}
