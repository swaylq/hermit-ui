import Foundation

/// The session detail panel's rules, with no SwiftUI in them.
///
/// A port of `components/chat/session-detail-core.ts`, which the web's own
/// `session-detail-sheet.tsx` calls — so `tools/detail-fixture.sh` compares two
/// implementations rather than an implementation against someone's reading of
/// the JSX.
///
/// What is a rule and what is a widget:
///   · a rule — which backend the pickers show, whether Apply is live, whether
///     a switch keeps the running context, what the mutation sends, and every
///     label/value pair in the read-only sections
///   · a widget — the sheet, the cards, the mode menu, the context bar
///
/// The read-only rows are in here for the same reason the action cluster's list
/// is: the ORDER and the exact strings are the answer, and two platforms
/// re-deriving them from a screenshot is how they drift.

// MARK: - The inputs

/// The half of `resolveRuntime`'s answer this panel reads.
struct DetailBackend: Decodable, Equatable, Sendable {
    var backendId: String
    var runtime: String
    var runtimeModel: String?
    var runtimeMode: String?
    var runtimeCredentialId: String?
}

/// What `chat.sessionDetail` returns, as far as this panel is concerned.
struct DetailSnapshot: Decodable, Equatable {
    var id: String
    var agentName: String
    var title: String?
    var titleAuto: Bool?
    var origin: String?
    var startedAt: Date?
    var lastMessageAt: Date?
    var lastActivity: Date?
    var closedAt: Date?
    var hiddenAt: Date?
    var hibernatedAt: Date?
    var snapshotAt: Date?
    var runtimeProvider: String?
    var runtimeModel: String?
    var runtimeMode: String?
    var claudeSessionId: String?
    var transcriptPath: String?
    var agentDirectory: String?
    var pid: Int?
    var alive: Bool?
    var state: String?
    var rssMb: Int?
    var activity: SessionActivity?
    var contextTokens: Int?
    var messageCount: Int
    var groupName: String?
    var backend: DetailBackend
    var agentBackend: DetailBackend
    var inherited: Bool
}

/// What the user has CHANGED, and nothing else — nil means "whatever the server
/// says". Keeping the form empty rather than seeded is what makes the 10s
/// refetch safe mid-edit.
struct DetailForm: Equatable, Sendable {
    var runtime: String?
    var mode: String?
    static let empty = DetailForm()
}

// MARK: - The pickers

struct DetailBackendCard: Equatable, Sendable {
    var id: String
    var label: String
    var blurb: String
    var builtIn: Bool
    /// Switched off in Settings → Backends, and only listed because we are ON it.
    var retired: Bool
    /// "what this agent normally uses" stays visible.
    var isAgentDefault: Bool
    var credentialId: String?
}

struct DetailPickerView: Equatable, Sendable {
    /// The card drawn as selected. Never a backend the session is not on.
    var shownBackend: String
    /// Does the HARNESS behind the chosen backend take a mode?
    var shownIsPi: Bool
    var currentMode: String
    var shownMode: String
    /// What the mode does, under the select. Nil for a mode this build doesn't list.
    var modeBlurb: String?
    /// Where the shown mode came from, or what Apply is about to do.
    var modeSource: String
    var dirty: Bool
    /// Mid-turn: the switch is refused rather than queued.
    var working: Bool
    /// A share link gets no machine-level control.
    var readOnly: Bool
    var inheritedLine: String
    var cards: [DetailBackendCard]
}

/// A sentence in pieces, so both platforms emphasise the same word.
struct Emphasised: Equatable, Sendable {
    var text: String
    var em: Bool = false
}

struct DetailSwitchPrompt: Equatable, Sendable {
    var title: String
    var message: [Emphasised]
    var confirmLabel: String
    /// The two Claude Code drivers write the same transcript, so moving between
    /// them resumes it rather than abandoning it. Saying otherwise would talk a
    /// user out of a move that costs nothing.
    var keepsContext: Bool
}

/// What `chat.setSessionRuntime` is sent. `runtimeMode` is OMITTED (not null)
/// on a switch away from pi — leaving the column alone keeps the mode for a
/// switch back — so it encodes as an absent key, which is why this is a manual
/// `encode(to:)` rather than a synthesised one.
struct DetailSavePayload: Equatable, Sendable, Encodable {
    var id: String
    var runtime: String
    var runtimeProvider: String?
    var runtimeModel: String?
    var runtimeMode: String?

    enum CodingKeys: String, CodingKey { case id, runtime, runtimeProvider, runtimeModel, runtimeMode }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(runtime, forKey: .runtime)
        // Explicit nulls: the two pins are CLEARED on a switch to a non-pi
        // backend, which is not the same as leaving them alone.
        try c.encode(runtimeProvider, forKey: .runtimeProvider)
        try c.encode(runtimeModel, forKey: .runtimeModel)
        if let runtimeMode { try c.encode(runtimeMode, forKey: .runtimeMode) }
    }
}

// MARK: - The read-only sections

enum DetailRowKind: String, Equatable, Sendable { case text, ctx, agent, task }

struct DetailRow: Equatable, Sendable {
    var label: String
    /// Nil draws the muted em-dash.
    var value: String?
    var mono: Bool = false
    /// Muted sans, after the value.
    var note: String?
    var kind: DetailRowKind = .text
    /// `.ctx` only.
    var ctxTokens: Int?
    var ctxTotal: Int?
}

struct DetailSection: Equatable, Sendable {
    var title: String
    var rows: [DetailRow]
    /// The small print under the section.
    var footer: String?
}

enum SessionDetailCore {
    // MARK: Stamp

    /// The server's answer as one string. When it moves — our save landed, or
    /// another device switched this session — the form is dropped.
    static func stamp(sessionId: String, _ d: DetailSnapshot?) -> String? {
        guard let d else { return nil }
        return "\(sessionId)|\(d.backend.backendId)|\(d.backend.runtimeMode ?? "")"
    }

    /// The sheet's own title.
    static func heading(_ d: DetailSnapshot?) -> String {
        if let t = d?.title, !t.isEmpty { return t }
        if let a = d?.agentName, !a.isEmpty { return a }
        return "Session"
    }

    static func sessionUrl(origin: String, sessionId: String) -> String {
        "\(origin)/chat?session=\(HermitAPI.percentEncoded(sessionId))"
    }

    // MARK: Labels

    static func backendLabel(_ cfg: BackendsConfig?, _ id: String) -> String {
        WebBackends.available(cfg, current: id).first(where: { $0.id == id })?.label
            ?? WebLabels.runtimeLabel(id)
    }

    /// A backend id is not a harness — a composed one has an id of its own.
    static func harnessOfBackend(_ cfg: BackendsConfig?, _ id: String) -> String {
        WebBackends.byId(cfg, id)?.harness ?? id
    }

    static func sideOfBackend(_ cfg: BackendsConfig?, _ id: String) -> (runtime: String?, credentialId: String?) {
        (harnessOfBackend(cfg, id), WebBackends.byId(cfg, id)?.credentialId)
    }

    static func cards(_ cfg: BackendsConfig?, selected: String, agentDefault: String?) -> [DetailBackendCard] {
        WebBackends.available(cfg, current: selected).map { b in
            DetailBackendCard(
                id: b.id, label: b.label, blurb: b.blurb, builtIn: b.builtIn,
                retired: !WebBackends.isEnabled(b.id, cfg),
                isAgentDefault: (agentDefault.map { !$0.isEmpty && b.id == $0 } ?? false),
                credentialId: b.credentialId
            )
        }
    }

    // MARK: The picker

    static func pickerView(d: DetailSnapshot?,
                           cfg: BackendsConfig?,
                           form: DetailForm,
                           scoped: Bool) -> DetailPickerView {
        // The last fallback is the resolver's own floor: reaching it means the
        // detail query has not answered yet, and naming a backend the session is
        // not on is the one thing these pickers must never do.
        let shownBackend = form.runtime ?? d?.backend.backendId ?? WebBackends.defaultBackendId
        // Follows the HARNESS behind the chosen backend, not its name: two
        // backends can both run pi against different credentials.
        let shownIsPi = WebBackends.byId(cfg, shownBackend)?.harness == "pi-rpc"
        // A claude session resolves to no mode at all, so flipping the picker to
        // pi opens the mode select on what the AGENT would start pi in — the
        // same answer "New chat" would give — rather than on the fleet default.
        // The removed triage router opens on the fleet default instead of on a
        // row the select does not offer; other unknown names pass through.
        let resolved = d?.backend.runtimeMode ?? d?.agentBackend.runtimeMode ?? PiModes.fleetDefault
        let currentMode = resolved == "triage" ? PiModes.fleetDefault : resolved
        let shownMode = form.mode ?? currentMode

        let modeSource: String
        if shownMode != currentMode {
            modeSource = "Applying pins it to this session."
        } else if let own = d?.runtimeMode, !own.isEmpty {
            modeSource = "Set on this session."
        } else if let d, currentMode == d.agentBackend.runtimeMode {
            modeSource = "Inherited from \(d.agentName)."
        } else {
            modeSource = "The default mode."
        }

        let agentDefaultId = d?.agentBackend.backendId
        let agentLabel = agentDefaultId.map { backendLabel(cfg, $0) } ?? ""
        let inheritedLine: String
        if let d {
            inheritedLine = d.inherited
                ? "Inherited from \(d.agentName) (\(agentLabel)). Choosing here pins it to this session."
                : "Set on this session. The agent's own default is \(agentLabel)."
        } else {
            inheritedLine = ""
        }

        let dirty: Bool
        if let d {
            dirty = shownBackend != d.backend.backendId
                || (shownIsPi && shownMode != (d.backend.runtimeMode ?? ""))
        } else {
            dirty = false
        }

        return DetailPickerView(
            shownBackend: shownBackend,
            shownIsPi: shownIsPi,
            currentMode: currentMode,
            shownMode: shownMode,
            modeBlurb: PiModes.blurb(shownMode),
            modeSource: modeSource,
            dirty: dirty,
            working: d?.state == "working",
            readOnly: scoped,
            inheritedLine: inheritedLine,
            cards: cards(cfg, selected: shownBackend, agentDefault: agentDefaultId)
        )
    }

    // MARK: The confirm, and what it sends

    static func switchPrompt(_ d: DetailSnapshot,
                             _ cfg: BackendsConfig?,
                             _ view: DetailPickerView) -> DetailSwitchPrompt {
        let changingBackend = view.shownBackend != d.backend.backendId
        let keepsContext = changingBackend && WebLabels.sharesConversation(
            before: (d.backend.runtime, d.backend.runtimeCredentialId),
            after: sideOfBackend(cfg, view.shownBackend)
        )
        let from = changingBackend ? backendLabel(cfg, d.backend.backendId) : "pi"
        let to = changingBackend ? backendLabel(cfg, view.shownBackend) : PiModes.label(view.shownMode)
        let message: [Emphasised] = keepsContext
            ? [Emphasised(text: "Both are Claude Code on the same conversation, so nothing is lost: \(backendLabel(cfg, d.backend.backendId)) is stopped and \(backendLabel(cfg, view.shownBackend)) resumes the same transcript, with its full history, on the next message.")]
            : [
                Emphasised(text: "The conversation on this page is kept. What is "),
                Emphasised(text: "not", em: true),
                Emphasised(text: " kept is the running context: \(from) is stopped, and the next message starts a fresh turn on \(to) with no memory of this thread beyond what you say in it."),
              ]
        return DetailSwitchPrompt(
            title: changingBackend
                ? "Switch to \(backendLabel(cfg, view.shownBackend))?"
                : "Switch mode to \(PiModes.label(view.shownMode))?",
            message: message,
            confirmLabel: changingBackend ? "Switch" : "Switch mode",
            keepsContext: keepsContext
        )
    }

    static func savePayload(_ d: DetailSnapshot, _ view: DetailPickerView) -> DetailSavePayload {
        DetailSavePayload(
            id: d.id,
            runtime: view.shownBackend,
            // The session's OWN pins, not the resolved ones. Writing a resolved
            // value would turn "inherits the agent's" into a pin, and on a
            // cross-backend switch it would pin the OLD backend's.
            runtimeProvider: view.shownIsPi ? d.runtimeProvider : nil,
            runtimeModel: view.shownIsPi ? d.runtimeModel : nil,
            runtimeMode: view.shownIsPi ? view.shownMode : nil
        )
    }

    // MARK: The read-only sections

    /// How many background tasks a snapshot claims, for the "cannot say which" line.
    static func bgCount(_ a: SessionActivity?) -> Int {
        let n = a?.backgroundCount ?? 0
        return n > 0 ? n : 0
    }

    static let backgroundFooter =
        "The turn ended; these did not. The session keeps its working dot until they finish, or for 30 minutes after the agent\u{2019}s last message \u{2014} whichever comes first."

    static func sections(_ d: DetailSnapshot, readOnly: Bool, now: Date = Date()) -> [DetailSection] {
        func rel(_ v: Date?) -> String? { v == nil ? nil : WebFormat.relTime(v, now: now) }
        var out: [DetailSection] = []

        // What is running OUTSIDE the turn — first, and only when there is any.
        //
        // A backgrounded Bash or subagent ends the turn the instant it starts,
        // so the session goes idle with work still going, and every surface
        // could say only the word "background". Which command, and for how long,
        // is the difference between a build that is nearly done and a `du` over
        // ~/Library that will still be running tomorrow.
        if SessionStatus.backgroundOutstanding(d.activity) {
            let tasks = SessionStatus.backgroundTaskList(d.activity)
            let rows: [DetailRow] = tasks.isEmpty
                ? [DetailRow(label: "running",
                             value: "\(bgCount(d.activity)) task\(bgCount(d.activity) == 1 ? "" : "s") \u{2014} this machine\u{2019}s gateway has not said which")]
                // The age gets the label column — it is what this list is
                // scanned for, and left-aligned durations compare by eye in a
                // way trailing ones do not. `.task` because that label is not
                // uppercased: "1H 28M" reads as a heading, not a clock.
                : tasks.map { t in
                    DetailRow(label: t.elapsedSec != 0 ? SessionStatus.shortDuration(t.elapsedSec) : "\u{2014}",
                              value: t.description, mono: true, kind: .task)
                }
            out.append(DetailSection(title: "background", rows: rows, footer: backgroundFooter))
        }

        var run: [DetailRow] = []
        // Reported, not edited: the switch is the chip in the chat header, one
        // click from the reply that made you want it, and keeping the only
        // control in one place is what stops this panel growing a second,
        // disagreeing answer.
        if d.backend.runtime == "claude-sdk" || d.backend.runtime == "codex-exec" {
            run.append(DetailRow(label: "model", value: d.backend.runtimeModel ?? "default",
                                 mono: true, note: "change it from the header chip"))
        }
        run.append(DetailRow(label: "state", value: d.state ?? "idle", mono: true,
                             note: d.hibernatedAt != nil
                                 ? "\u{1F4A4} asleep since \(rel(d.hibernatedAt) ?? "")"
                                 : nil))
        run.append(DetailRow(label: "context", value: nil, kind: .ctx,
                             ctxTokens: d.contextTokens,
                             ctxTotal: WebLabels.contextWindowFor(runtime: d.backend.runtime,
                                                                  model: d.backend.runtimeModel)))
        // `d.pid ? …` and `d.rssMb ? …` in the original: 0 is falsy in
        // JavaScript, so a zero pid or a zero RSS drops its half entirely.
        let pidPart = (d.pid ?? 0) != 0 ? " \u{B7} pid \(d.pid!)" : ""
        let rssPart = (d.rssMb ?? 0) != 0 ? " \u{B7} \(d.rssMb!) MB" : ""
        run.append(DetailRow(label: "process",
                             value: (d.alive ?? false) ? "alive\(pidPart)\(rssPart)" : "not running",
                             mono: true))
        run.append(DetailRow(label: "snapshot", value: rel(d.snapshotAt)))
        run.append(DetailRow(label: "last activity", value: rel(d.lastActivity)))
        out.append(DetailSection(title: "run", rows: run))

        let flags = [d.closedAt != nil ? "closed" : nil,
                     d.hiddenAt != nil ? "hidden" : nil,
                     (d.origin?.isEmpty == false) ? "origin:\(d.origin!)" : nil]
            .compactMap { $0 }
            .joined(separator: " \u{B7} ")
        out.append(DetailSection(title: "conversation", rows: [
            DetailRow(label: "messages", value: "\(d.messageCount)", mono: true),
            DetailRow(label: "started", value: rel(d.startedAt)),
            DetailRow(label: "last message", value: rel(d.lastMessageAt)),
            DetailRow(label: "title",
                      value: (d.title?.isEmpty == false)
                          ? "\(d.title!)\((d.titleAuto ?? false) ? " (auto)" : "")"
                          : nil),
            DetailRow(label: "group", value: d.groupName),
            DetailRow(label: "flags", value: flags.isEmpty ? nil : flags),
        ]))

        var where_: [DetailRow] = [
            DetailRow(label: "agent", value: d.agentName, mono: true, kind: .agent),
        ]
        // Filesystem paths and the backend's own session id are machine
        // internals — not for a share link, which only ever gets one agent's
        // conversation.
        if !readOnly {
            // `?? null`, not a truthiness test: an empty string is a value
            // here and draws as empty, where the three rows above use `?:` and
            // fold '' into the dash. Copied as written rather than tidied —
            // that asymmetry is the web's, and the fixture holds us to it.
            where_.append(DetailRow(label: "directory", value: d.agentDirectory, mono: true))
            where_.append(DetailRow(label: "backend id", value: d.claudeSessionId, mono: true))
            where_.append(DetailRow(label: "transcript", value: d.transcriptPath, mono: true))
        }
        out.append(DetailSection(title: "where", rows: where_))
        return out
    }
}
