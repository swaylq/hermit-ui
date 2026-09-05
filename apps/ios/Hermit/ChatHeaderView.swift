import SwiftUI

/// The chat screen's header, drawn to match `app/chat/page.tsx`.
///
/// ## Why the screen has one at all
///
/// Round 3 turned off iOS 26's scroll edge effect: flipped upside down it ran at
/// full strength across the whole conversation and washed the timeline out to
/// about 15% contrast. That was the right call — the web draws no such effect —
/// but it left a translucent navigation bar with nothing behind it, so the
/// oldest row on screen scrolled through the title and the back button.
///
/// The answer is not to put a blur back. The web's chat header is OPAQUE, and
/// "the same as the web" is the standard this screen is held to; so the
/// navigation bar stays hidden here and this is drawn instead. It also gets the
/// meta line, which a `UINavigationBar` title has nowhere to put: which agent,
/// what it is doing, which backend, how full its context is.
///
/// ## What is not here yet
///
/// The right-hand action cluster (new chat, terminal, delete, and the five in
/// the phone's overflow tray), the model chip, tapping the title to rename, and
/// the two chips that open the session detail sheet. Every one of those is a
/// mutation or a second query rather than a piece of layout, and they are
/// written down as their own checklist lines in `docs/ios-native-progress.md`
/// rather than left implied by this comment.
enum ChatHeaderMetrics {
    /// `h-12`.
    static let height: CGFloat = 48
    /// `px-4` on the header itself.
    static let padH: CGFloat = 16
    /// `gap-2` between the leading control and the title block.
    static let leadingGap: CGFloat = 8

    /// `h-5 w-5` inside `p-1.5`, pulled back by `-ml-1`.
    static let controlIcon: CGFloat = 20
    static let controlPad: CGFloat = 6
    static let controlOffset: CGFloat = -4

    /// `text-sm` + `leading-tight`: 14px over a 17.5px line box.
    static let titleFont: CGFloat = 14
    static let titleLine: CGFloat = 17.5
    /// `mt-0.5` between the title and the meta line.
    static let lineGap: CGFloat = 2
    /// `text-[10px]` with no line-height of its own, so preflight's 1.5.
    static let metaFont: CGFloat = 10
    static let metaLine: CGFloat = 15
    /// `gap-1.5` between the meta line's items, `gap-1` inside the ctx readout.
    static let metaGap: CGFloat = 6
    static let ctxGap: CGFloat = 4

    /// `max-w-[9rem]` on the agent name and `max-w-[11rem]` on the state label
    /// are NOT here, and the omission is deliberate — see `ChatHeaderView.meta`.

    /// The `mini` context bar: `h-[3px] w-8`.
    static let ctxTrack = CGSize(width: 32, height: 3)

    /// `border-b border-border`, one CSS pixel.
    static let hairline: CGFloat = 1
}

/// Everything the header draws, resolved once so the view has no opinions.
struct ChatHeaderModel: Equatable {
    var title: String
    var agentName: String?
    var status: StatusView?
    /// `runtimeShortLabel`, or the credential's provider when there is one —
    /// below 40rem the web shows the vendor ALONE, because that is the half you
    /// cannot deduce (you chose the backend; you cannot see the endpoint).
    var backend: String
    var contextTokens: Int?
    var contextWindow: Int
    var closed: Bool

    /// The state the screen paints in before `chat.getSession` answers: the id's
    /// first eight characters and nothing else. Every later field is optional
    /// for the same reason — a header that waits for the network is a header
    /// that is blank for the first second of every session.
    static func pending(sessionId: String, title: String?) -> ChatHeaderModel {
        // A title off the deep link if it carried one — the same JS falsiness as
        // the ladder itself, so an empty string falls through rather than
        // printing a blank screen name.
        let opening = title.flatMap { $0.isEmpty ? nil : $0 }
            ?? SessionMeta.headerTitle(nil, sessionId: sessionId)
        return ChatHeaderModel(
            title: opening,
            agentName: nil, status: nil,
            backend: WebLabels.runtimeShortLabel(nil),
            contextTokens: nil, contextWindow: WebLabels.defaultContextWindow, closed: false
        )
    }

    init(title: String, agentName: String?, status: StatusView?, backend: String,
         contextTokens: Int?, contextWindow: Int, closed: Bool) {
        self.title = title
        self.agentName = agentName
        self.status = status
        self.backend = backend
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.closed = closed
    }

    /// Built from what `chat.getSession` said, with the status judged by the
    /// same `sessionStatusView` the sidebar row runs.
    ///
    /// `unread: false` — we are looking at this session, so it is read by
    /// definition, and the header never shows its own unread dot. `needsYou`
    /// stays false until the timeline can see a pending interaction card (M4);
    /// the gateway's own `blocked` state still reaches the same answer a beat
    /// later, so the dot is late here, not wrong.
    init(meta: SessionMeta, sessionId: String, now: Date = Date()) {
        self.title = SessionMeta.headerTitle(meta, sessionId: sessionId)
        self.agentName = meta.agentName.isEmpty ? nil : meta.agentName
        self.status = SessionStatus.view(meta.statusRow,
                                         StatusOptions(unread: false, now: now.timeIntervalSince1970 * 1000))
        // `providerMark` first: on a phone the web hides the harness name and
        // shows the vendor alone whenever a session runs on a credential.
        let vendor = meta.runtimeCredentialId != nil ? WebLabels.providerMark(meta.runtimeProvider) : nil
        self.backend = vendor ?? WebLabels.runtimeShortLabel(meta.runtime)
        self.contextTokens = meta.contextTokens
        self.contextWindow = WebLabels.contextWindowFor(runtime: meta.runtime, model: meta.runtimeModel)
        self.closed = meta.closedAt != nil
    }
}

struct ChatHeaderView: View {
    let model: ChatHeaderModel
    /// Nil when there is nowhere to go back to.
    var onBack: (() -> Void)?

    @Environment(\.colorScheme) private var scheme

    private var muted: Color { WebContract.mutedForeground.resolve(scheme) }
    private var fg: Color { WebContract.foreground.resolve(scheme) }

    var body: some View {
        HStack(spacing: ChatHeaderMetrics.leadingGap) {
            if let onBack { control(onBack) }
            VStack(alignment: .leading, spacing: ChatHeaderMetrics.lineGap) {
                Text(model.title)
                    .font(.system(size: ChatHeaderMetrics.titleFont, weight: .semibold))
                    .foregroundStyle(fg)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    // CSS centres the glyphs in the line box; SwiftUI sizes the
                    // box from the font. `.frame` is the difference, and it is
                    // what puts the two lines on the web's baselines.
                    .frame(height: ChatHeaderMetrics.titleLine, alignment: .leading)
                meta
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, ChatHeaderMetrics.padH)
        .frame(height: ChatHeaderMetrics.height)
        .frame(maxWidth: .infinity)
        .background(WebContract.background.resolve(scheme))
        // `border-b`: a hairline INSIDE the 48pt box, the way a CSS border sits
        // inside a fixed height.
        .overlay(alignment: .bottom) {
            WebContract.border.resolve(scheme)
                .frame(height: ChatHeaderMetrics.hairline)
        }
    }

    /// The leading control, in the slot the web's sidebar toggle occupies.
    ///
    /// It is a back chevron and not a hamburger because the shell has no native
    /// drawer yet — the page's toggle opens one, and a glyph that promised a
    /// drawer and delivered a pop would be worse than the honest arrow. When the
    /// drawer lands (M3) this becomes the toggle and this comment goes away.
    private func control(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "chevron.backward")
                .font(.system(size: 15, weight: .medium))
                .frame(width: ChatHeaderMetrics.controlIcon, height: ChatHeaderMetrics.controlIcon)
                .padding(ChatHeaderMetrics.controlPad)
                .foregroundStyle(muted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("back")
        // The web's target is 32px too. Grown to the header's full height here
        // rather than left at 32: a horizontal miss lands on the title, a
        // vertical one lands on nothing.
        .frame(height: ChatHeaderMetrics.height)
        .contentShape(Rectangle())
        .padding(.leading, ChatHeaderMetrics.controlOffset)
    }

    /// `text-[10px] font-mono text-muted-foreground`, one line, no wrapping.
    ///
    /// Which items yield is the whole design of this row. The agent name and the
    /// state label shrink (`min-w-0` on the web, no `fixedSize` here);
    /// everything after them is fixed, so a long state — "general-purpose +2 bg"
    /// — concedes width instead of running the context bar off the edge. Both
    /// sides then split the shortfall in proportion to width, so the long state
    /// concedes more than the short agent name: SwiftUI's HStack and CSS
    /// flexbox happen to agree exactly here.
    ///
    /// The web's `max-w-[9rem]` / `max-w-[11rem]` caps are deliberately NOT
    /// reproduced. `.frame(maxWidth:)` is GREEDY in SwiftUI — it expands into
    /// whatever slack the row has instead of sizing to its text — so the first
    /// version of this row left a 100pt hole after a four-letter agent name and
    /// truncated "Bash · 47s" to "4…" beside it. At phone widths the caps cannot
    /// bind anyway: about 175pt is left for the two of them, so shrinking
    /// reaches them first and the cap never applies. On an iPad it would, and a
    /// non-greedy cap is written down as its own line in the progress doc rather
    /// than faked here.
    private var meta: some View {
        HStack(spacing: ChatHeaderMetrics.metaGap) {
            if let agent = model.agentName {
                Text(agent)
                    .foregroundStyle(fg.opacity(0.7))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if let status = model.status {
                dotSeparator
                HStack(spacing: ChatHeaderMetrics.metaGap) {
                    StatusDot(status: status)
                    Text(status.label)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                dotSeparator
                Text(model.backend).fixedSize()
                dotSeparator
                ctx
            }
            if model.closed {
                dotSeparator
                Text("closed").fixedSize()
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: ChatHeaderMetrics.metaFont, design: .monospaced))
        .monospacedDigit()
        .foregroundStyle(muted)
        .frame(height: ChatHeaderMetrics.metaLine)
    }

    private var dotSeparator: some View {
        Text("·").foregroundStyle(muted.opacity(0.4)).fixedSize()
    }

    /// `<CtxBar variant="mini" showLabel={false}>`: the token count people
    /// actually read, plus a shortened track, minus the percent — about 55px
    /// instead of the full variant's 130, which is what makes it fit a 390px
    /// header next to the agent name and the state.
    private var ctx: some View {
        let known = model.contextTokens != nil
        let pct = WebLabels.ctxPct(model.contextTokens, total: model.contextWindow)
        let fill = known ? WebLabels.ctxFill(pct) : 0
        // The colour bands are integer thresholds, so flooring first is exact:
        // `floor(p) >= 90` and `p >= 90` are the same question. The fixture
        // checks that over every case in its table.
        let colour = StatusPalette.ctxBar(Int(pct.rounded(.down)))
        return HStack(spacing: ChatHeaderMetrics.ctxGap) {
            Text(known ? WebLabels.fmtBytes(model.contextTokens) : "—")
                .foregroundStyle(fg)
                .fixedSize()
            ZStack(alignment: .leading) {
                Capsule().fill(fg.opacity(0.1))
                // `ring-1 ring-foreground/5` — drawn outside the track on the
                // web, so it is an overlay here and not an inset stroke.
                Capsule().strokeBorder(fg.opacity(0.05), lineWidth: 1)
                Capsule()
                    .fill(colour)
                    .frame(width: ChatHeaderMetrics.ctxTrack.width * fill / 100)
            }
            .frame(width: ChatHeaderMetrics.ctxTrack.width, height: ChatHeaderMetrics.ctxTrack.height)
            .accessibilityHidden(true)
        }
        .fixedSize()
    }
}
