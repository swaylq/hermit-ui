import SwiftUI

/// Everything about ONE chat session, and what you can change about it from
/// here: which backend runs it, and — on pi — which mode.
///
/// The native half of `components/chat/session-detail-sheet.tsx`. Every rule it
/// draws comes from `SessionDetailCore`, which `tools/detail-fixture.sh` holds
/// against the web's own functions — so this file is only widgets: the panel,
/// the rows, the cards, the mode menu, the two buttons.
///
/// A panel over the conversation rather than a screen of its own, for the
/// reason the web gives: the conversation behind it is the context you need to
/// decide whether to move this session onto another backend.

// MARK: - Metrics

enum DetailMetrics {
    /// `p-4 space-y-5` on the scroller.
    static let bodyPad: CGFloat = 16
    static let sectionGap: CGFloat = 20
    /// `SheetHeader`: `p-4` with a `gap-4` column, minus the description's own pt-1.
    static let headerPad: CGFloat = 16
    /// `w-28` — the label column of a `Row`.
    static let labelWidth: CGFloat = 112
    /// `w-20` — the age column of a background task.
    static let taskLabelWidth: CGFloat = 80
    /// `py-1.5` above and below a row's content.
    static let rowPadV: CGFloat = 6
    /// `gap-3` between a row's label and its value.
    static let rowGap: CGFloat = 12

    /// `text-[11px] uppercase tracking-wide` — the row labels and the badges.
    static let labelFont: CGFloat = 11
    static let labelTracking: CGFloat = 0.275   // `tracking-wide` = 0.025em
    /// `text-[13px]` — a row's value.
    static let valueFont: CGFloat = 13
    /// `text-xs` — a mono value, and a section heading.
    static let smallFont: CGFloat = 12
    /// `text-sm` — the sheet title and a card's name.
    static let titleFont: CGFloat = 14
    /// `text-[10px]` / `text-[9px]` — a credential line and a card badge.
    static let tinyFont: CGFloat = 10
    static let badgeFont: CGFloat = 9

    /// `rounded-lg` on a backend card, `px-3 py-2.5`.
    static let cardRadius: CGFloat = 8
    static let cardPadH: CGFloat = 12
    static let cardPadV: CGFloat = 10
    static let cardGap: CGFloat = 8

    /// `transition duration-200 ease-in-out` on the panel, and the backdrop's
    /// own `duration-150`. The panel does NOT slide the whole way in: the web
    /// fades it and translates 2.5rem, which is what these two are.
    static let openDuration: TimeInterval = 0.2
    static let backdropDuration: TimeInterval = 0.15
    static let slideIn: CGFloat = 40
    /// `bg-black/10`, plus the backdrop-filter the browser applies when it can.
    static let backdropAlpha: Double = 0.1
}

// MARK: - The panel

struct SessionDetailView: View {
    @ObservedObject var model: SessionDetailModel
    /// False draws the body unscrolled, so `tools/render-detail.sh` can put a
    /// panel that is taller than a phone into one image. ImageRenderer lays a
    /// `ScrollView` out at zero height and the shot comes back empty — which is
    /// how this argument came to exist.
    var scrolls = true
    @Environment(\.colorScheme) private var scheme

    private var fg: Color { WebContract.popoverForeground.resolve(scheme) }
    private var muted: Color { WebContract.mutedForeground.resolve(scheme) }
    private var border: Color { WebContract.border.resolve(scheme) }

    var body: some View {
        VStack(spacing: 0) {
            header
            if model.loading && model.detail == nil {
                // `<Skeleton className="h-24" />` twice, in a `p-6 space-y-3`.
                VStack(spacing: 12) {
                    skeleton(96)
                    skeleton(128)
                }
                .padding(24)
                Spacer(minLength: 0)
            } else if model.gone {
                Text("This session no longer exists.")
                    .font(.system(size: DetailMetrics.titleFont))
                    .foregroundStyle(muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
                Spacer(minLength: 0)
            } else if let d = model.detail {
                body(for: d)
            } else if let err = model.error {
                Text("error: \(err)")
                    .font(.system(size: DetailMetrics.titleFont))
                    .foregroundStyle(WebContract.rose400)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(WebContract.popover.resolve(scheme))
        .accessibilityIdentifier("detail.panel")
    }

    private func skeleton(_ h: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(WebContract.accent.resolve(scheme))
            .frame(height: h)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 4) {
                Text(SessionDetailCore.heading(model.detail))
                    .font(.system(size: DetailMetrics.titleFont, weight: .semibold))
                    .foregroundStyle(fg)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("detail.title")
                // The sheet's own close X.
                iconButton("xmark", label: "close") { model.close() }
                    .accessibilityIdentifier("detail.close")
            }
            HStack(alignment: .top, spacing: 4) {
                // Wraps rather than truncates: the tail of a session url is the
                // id, which is the half worth reading, and on a phone an
                // ellipsis eats exactly that.
                Text(model.url)
                    .font(.system(size: DetailMetrics.labelFont, design: .monospaced))
                    .foregroundStyle(muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                iconButton(model.copied == .ok ? "checkmark" : "doc.on.doc",
                           label: "Copy session link",
                           tint: model.copied == .ok ? WebContract.emerald500
                               : model.copied == .fail ? WebContract.rose400 : nil) {
                    model.copyUrl()
                }
                .accessibilityIdentifier("detail.copy")
            }
        }
        .padding(DetailMetrics.headerPad)
        .background(alignment: .bottom) {
            border.frame(height: 1).frame(maxHeight: .infinity, alignment: .bottom)
        }
    }

    private func iconButton(_ symbol: String, label: String, tint: Color? = nil,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .regular))
                .frame(width: 28, height: 28)
                .foregroundStyle(tint ?? muted)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: Body

    @ViewBuilder
    private func body(for d: DetailSnapshot) -> some View {
        let sections = SessionDetailCore.sections(d, readOnly: model.view.readOnly)
        ScrollableIf(scrolls) {
            VStack(alignment: .leading, spacing: DetailMetrics.sectionGap) {
                // `background` is first and only sometimes — this panel opens
                // from the status chip, and when that chip says "background"
                // this is the answer it was tapped for.
                ForEach(sections.filter { $0.title == "background" }, id: \.title) { s in
                    section(s, agentName: d.agentName)
                }
                backendSection(d)
                ForEach(sections.filter { $0.title != "background" }, id: \.title) { s in
                    section(s, agentName: d.agentName)
                }
            }
            .padding(DetailMetrics.bodyPad)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sectionHeading(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: DetailMetrics.smallFont))
            .tracking(0.3)
            .foregroundStyle(muted)
            .padding(.bottom, 6)
    }

    private func section(_ s: DetailSection, agentName: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeading(s.title)
            ForEach(Array(s.rows.enumerated()), id: \.offset) { i, r in
                row(r, last: i == s.rows.count - 1)
            }
            if let footer = s.footer {
                Text(footer)
                    .font(.system(size: DetailMetrics.labelFont))
                    .foregroundStyle(muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }
        }
    }

    private func row(_ r: DetailRow, last: Bool) -> some View {
        HStack(alignment: .top, spacing: DetailMetrics.rowGap) {
            if r.kind == .task {
                // The age gets the label column, un-uppercased: "1H 28M" reads
                // as a heading, not a clock.
                Text(r.label)
                    .font(.system(size: DetailMetrics.labelFont, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(muted)
                    .frame(width: DetailMetrics.taskLabelWidth, alignment: .leading)
                    .padding(.top, 2)
            } else {
                Text(r.label.uppercased())
                    .font(.system(size: DetailMetrics.labelFont))
                    .tracking(DetailMetrics.labelTracking)
                    .foregroundStyle(muted)
                    .frame(width: DetailMetrics.labelWidth, alignment: .leading)
                    .padding(.top, 2)
            }
            value(r)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, DetailMetrics.rowPadV)
        .overlay(alignment: .bottom) {
            // `border-b border-border/40 last:border-0`.
            if !last { border.opacity(0.4).frame(height: 1) }
        }
        .accessibilityIdentifier("detail.row.\(r.label)")
    }

    @ViewBuilder
    private func value(_ r: DetailRow) -> some View {
        switch r.kind {
        case .ctx:
            DetailCtxBar(tokens: r.ctxTokens, total: r.ctxTotal ?? 0)
        default:
            let text = r.value
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Group {
                    if let text {
                        Text(text)
                            .font(r.mono
                                  ? .system(size: DetailMetrics.smallFont, design: .monospaced)
                                  : .system(size: DetailMetrics.valueFont))
                            .foregroundStyle(fg.opacity(0.9))
                    } else {
                        // The muted em-dash: a row that has nothing to say says
                        // so, rather than collapsing and moving the row below it.
                        Text("\u{2014}").font(.system(size: DetailMetrics.valueFont))
                            .foregroundStyle(muted.opacity(0.5))
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                if let note = r.note {
                    Text(note)
                        .font(.system(size: DetailMetrics.labelFont))
                        .foregroundStyle(muted)
                        .padding(.leading, 8)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: The backend picker

    @ViewBuilder
    private func backendSection(_ d: DetailSnapshot) -> some View {
        let v = model.view
        VStack(alignment: .leading, spacing: 0) {
            sectionHeading("backend")
            // `grid-cols-1` below 420px: on a phone two columns wrap each blurb
            // to five lines and the cards stop being scannable.
            VStack(spacing: DetailMetrics.cardGap) {
                ForEach(v.cards, id: \.id) { c in
                    card(c, selected: c.id == v.shownBackend,
                         disabled: v.readOnly || v.working || model.saving || c.retired)
                }
            }
            if v.cards.allSatisfy({ $0.builtIn }) {
                Text("Only the subscription backends are set up here. Pair a harness with a credential under Settings \u{2192} Backends to add pi, Prime Agent or DeepSeek.")
                    .font(.system(size: DetailMetrics.labelFont))
                    .foregroundStyle(muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, DetailMetrics.cardGap)
            }
            if v.shownIsPi { modePicker(v) }
            Text(v.inheritedLine)
                .font(.system(size: DetailMetrics.labelFont))
                .foregroundStyle(muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
            if v.working {
                Text("Mid-turn \u{2014} the switch is disabled until this turn finishes.")
                    .font(.system(size: DetailMetrics.labelFont))
                    .foregroundStyle(WebContract.amber500)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                    .accessibilityIdentifier("detail.midturn")
            }
            if let err = model.saveError {
                Text(err)
                    .font(.system(size: DetailMetrics.labelFont))
                    .foregroundStyle(WebContract.rose500)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }
            if !v.readOnly { applyRow(d, v) }
        }
    }

    private func card(_ c: DetailBackendCard, selected: Bool, disabled: Bool) -> some View {
        Button { model.pick(c.id) } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(c.label)
                        .font(.system(size: DetailMetrics.titleFont, weight: .medium))
                        .foregroundStyle(WebContract.foreground.resolve(scheme))
                    if c.builtIn { badge("subscription", muted) }
                    if c.isAgentDefault { badge("default", muted) }
                    if c.retired {
                        badge("off", scheme == .dark ? WebContract.amber400 : WebContract.amber600)
                    }
                    Spacer(minLength: 0)
                }
                if let cred = c.credentialId {
                    Text(cred)
                        .font(.system(size: DetailMetrics.tinyFont, design: .monospaced))
                        .foregroundStyle(muted.opacity(0.8))
                        .lineLimit(1)
                }
                Text(c.blurb)
                    .font(.system(size: DetailMetrics.labelFont))
                    .foregroundStyle(muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, DetailMetrics.cardPadH)
            .padding(.vertical, DetailMetrics.cardPadV)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: DetailMetrics.cardRadius)
                    .fill(selected ? WebContract.accent.resolve(scheme) : WebContract.card.resolve(scheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: DetailMetrics.cardRadius)
                    .strokeBorder(selected
                                  ? WebContract.foreground.resolve(scheme).opacity(0.4)
                                  : border,
                                  lineWidth: 1)
            )
            .opacity(disabled ? 0.5 : 1)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityIdentifier("detail.backend.\(c.id)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func badge(_ s: String, _ colour: Color) -> some View {
        Text(s.uppercased())
            .font(.system(size: DetailMetrics.badgeFont))
            .tracking(0.225)
            .foregroundStyle(colour)
    }

    private func modePicker(_ v: DetailPickerView) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("MODE")
                .font(.system(size: DetailMetrics.labelFont))
                .tracking(DetailMetrics.labelTracking)
                .foregroundStyle(muted)
            Menu {
                ForEach(PiModes.all, id: \.self) { m in
                    Button(PiModes.meta[m]!.label) { model.pickMode(m) }
                }
            } label: {
                HStack {
                    Text(PiModes.label(v.shownMode))
                        .font(.system(size: DetailMetrics.titleFont))
                        .foregroundStyle(WebContract.foreground.resolve(scheme))
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 10))
                        .foregroundStyle(muted)
                }
                .padding(.horizontal, DetailMetrics.cardPadH)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 6).fill(WebContract.card.resolve(scheme)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(border, lineWidth: 1))
            }
            .disabled(v.readOnly || v.working || model.saving)
            .accessibilityIdentifier("detail.mode")
            Text([v.modeBlurb, v.modeSource].compactMap { $0 }.joined(separator: " "))
                .font(.system(size: DetailMetrics.labelFont))
                .foregroundStyle(muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 10)
    }

    private func applyRow(_ d: DetailSnapshot, _ v: DetailPickerView) -> some View {
        HStack(spacing: 8) {
            Button { model.apply() } label: {
                Text(model.saving ? "switching\u{2026}" : "Apply")
                    .font(.system(size: DetailMetrics.smallFont, weight: .medium))
                    .foregroundStyle(WebContract.primaryForeground.resolve(scheme))
                    .padding(.horizontal, 12)
                    .frame(height: 32)
                    .background(RoundedRectangle(cornerRadius: 6)
                        .fill(WebContract.primary.resolve(scheme)))
            }
            .buttonStyle(.plain)
            .disabled(!v.dirty || v.working || model.saving)
            .opacity(!v.dirty || v.working || model.saving ? 0.5 : 1)
            .accessibilityIdentifier("detail.apply")

            if v.dirty && !model.saving {
                Button { model.resetForm() } label: {
                    Text("reset")
                        .font(.system(size: DetailMetrics.smallFont))
                        .foregroundStyle(WebContract.foreground.resolve(scheme))
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("detail.reset")
            }
            if model.restarted && !v.dirty {
                Text("stopped \u{2014} the next message starts it on \(SessionDetailCore.backendLabel(model.config, d.backend.backendId))"
                     + (d.backend.runtime == "pi-rpc" ? " \u{B7} \(PiModes.label(v.currentMode))" : ""))
                    .font(.system(size: DetailMetrics.labelFont))
                    .foregroundStyle(muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 10)
    }
}

/// A `ScrollView`, or the same content laid out plainly. See `scrolls`.
struct ScrollableIf<Content: View>: View {
    let on: Bool
    @ViewBuilder let content: () -> Content
    init(_ on: Bool, @ViewBuilder content: @escaping () -> Content) {
        self.on = on
        self.content = content
    }
    var body: some View {
        if on { ScrollView { content() } } else { content() }
    }
}

/// `<CtxBar>` at its FULL size — `ctx 51.2k [track] 5%`. The chat header draws
/// the `mini` variant (no percent, a 32px track); the panel has the width for
/// the whole thing, which is what the web puts here.
struct DetailCtxBar: View {
    let tokens: Int?
    let total: Int
    @Environment(\.colorScheme) private var scheme

    /// `w-14` / `h-[4px]`, and `gap-1.5`.
    static let track = CGSize(width: 56, height: 4)

    var body: some View {
        let known = tokens != nil
        let pct = WebLabels.ctxPct(tokens, total: total)
        let fill = known ? WebLabels.ctxFill(pct) : 0
        let fg = WebContract.foreground.resolve(scheme)
        let muted = WebContract.mutedForeground.resolve(scheme)
        return HStack(spacing: 6) {
            Text("ctx").foregroundStyle(muted.opacity(0.7)).fixedSize()
            Text(known ? WebLabels.fmtBytes(tokens) : "\u{2014}")
                .foregroundStyle(fg)
                .monospacedDigit()
                .fixedSize()
            ZStack(alignment: .leading) {
                Capsule().fill(fg.opacity(0.1))
                Capsule().strokeBorder(fg.opacity(0.05), lineWidth: 1)
                // `width: ${fill}%` — a PERCENTAGE, not a fraction.
                Capsule().fill(StatusPalette.ctxBar(Int(pct.rounded(.down))))
                    .frame(width: Self.track.width * fill / 100)
            }
            .frame(width: Self.track.width, height: Self.track.height)
            .accessibilityHidden(true)
            // `pct.toFixed(0)` ROUNDS, while the colour bands floor — 89.6% is
            // drawn green and labelled "90%", on both platforms.
            Text(known ? "\(WebLabels.jsToFixed(pct, 0))%" : "\u{2014}")
                .foregroundStyle(StatusPalette.ctxText(Int(pct.rounded(.down))))
                .monospacedDigit()
                .fixedSize()
        }
        .font(.system(size: DetailMetrics.smallFont))
    }
}
