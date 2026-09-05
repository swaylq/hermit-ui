import Foundation

/// Which backends a machine offers, and what a pi mode is called.
///
/// A port of the picker's half of `lib/backends.ts` and of `lib/pi-modes.ts`.
/// `tools/detail-fixture.sh` runs both against the web's own answers, so the
/// built-in list, the blurbs and the mode labels are compared rather than
/// trusted.
///
/// Only what a PICKER needs is here. Composing, renaming and deleting a backend
/// happen under Settings → Backends, which is a web screen on this phone, so
/// `toggleBackend` / `addBackendInstance` / `uniqueBackendId` are deliberately
/// absent — porting a writer with no caller is how a second, disagreeing copy
/// of a rule gets started.

/// A composed backend: a harness plus somebody's credential.
struct BackendInstance: Decodable, Equatable, Sendable {
    var id: String
    var harness: String
    var credentialId: String
    var label: String
    var model: String?
    var mode: String?
}

/// The machine's own backend settings (`machines.getBackendsConfig`).
struct BackendsConfig: Decodable, Equatable, Sendable {
    /// Stored as the DISABLED set, not the enabled one.
    var disabled: [String] = []
    var instances: [BackendInstance]?
    var dshSource: String?
}

/// What a picker renders, built-in and composed alike.
struct Backend: Equatable, Sendable {
    var id: String
    var harness: String
    var label: String
    var blurb: String
    var builtIn: Bool
    /// Nil for the built-ins: their credential is a subscription, not a row.
    var credentialId: String?
    var model: String?
    var mode: String?
}

enum WebBackends {
    /// The floor. Needs no per-machine setup, so it is what an empty config means.
    static let defaultBackendId = "claude-sdk"

    /// `RUNTIME_BLURB` — the one-liner under each card. Compared by the fixture
    /// character for character, curly apostrophes included.
    static let runtimeBlurb: [String: String] = [
        "claude-sdk": "Claude Code via its official Agent SDK. Same tools and skills; typed events, no pane. Built in it runs on this machine\u{2019}s subscription; paired with a credential it runs that endpoint\u{2019}s model instead.",
        "claude-tmux": "The same Claude Code, driven through a tmux pane. Attachable terminal, and it survives a gateway restart.",
        "pi-rpc": "pi or omp as an RPC child process. Small and predictable; pick the engine and recipe under Mode.",
        "prime-rpc": "Prime Agent. One tool \u{2014} a persistent IPython kernel \u{2014} plus subagents and a self-refining harness.",
        "codex-exec": "OpenAI Codex, one run per turn, on this machine\u{2019}s own codex login.",
        "dsh-exec": "DeepSeek Harness (dsh), one run per turn, resumed by session id.",
        "kimi-code": "Moonshot\u{2019}s own Kimi Code CLI, one run per turn, resumed by session id. Its own tools, skills, sub-agents and hooks; the key is passed in the environment and nothing is written to its config.",
    ]

    /// The three that ship enabled, in the order the picker draws them. Their
    /// ids ARE the harness kinds they run — every existing session row stores
    /// one of those strings.
    static let builtIn: [Backend] = [
        Backend(id: "claude-sdk", harness: "claude-sdk", label: "Claude Code",
                blurb: runtimeBlurb["claude-sdk"]!, builtIn: true,
                credentialId: nil, model: nil, mode: nil),
        Backend(id: "claude-tmux", harness: "claude-tmux", label: "Claude Code (tmux)",
                blurb: runtimeBlurb["claude-tmux"]!, builtIn: true,
                credentialId: nil, model: nil, mode: nil),
        Backend(id: "codex-exec", harness: "codex-exec", label: "Codex",
                blurb: runtimeBlurb["codex-exec"]!, builtIn: true,
                credentialId: nil, model: nil, mode: nil),
    ]

    private static let builtInIds: Set<String> = Set(builtIn.map(\.id))

    /// `CUSTOM_HARNESSES` — the kinds a composed backend may name.
    static let customHarnesses: Set<String> = ["pi-rpc", "prime-rpc", "dsh-exec", "kimi-code", "claude-sdk"]

    static func instances(_ config: BackendsConfig?) -> [BackendInstance] {
        // `readInstances`'s filter, which the server applies on the way out but
        // which this phone must apply too: a payload from a newer gateway can
        // carry an instance this build cannot render.
        (config?.instances ?? []).filter {
            !$0.id.isEmpty && !builtInIds.contains($0.id)
                && customHarnesses.contains($0.harness) && !$0.credentialId.isEmpty
        }
    }

    static func asBackend(_ i: BackendInstance) -> Backend {
        Backend(id: i.id, harness: i.harness,
                label: i.label.isEmpty ? i.id : i.label,
                blurb: runtimeBlurb[i.harness] ?? "",
                builtIn: false, credentialId: i.credentialId,
                model: i.model, mode: i.mode)
    }

    /// Every backend this machine knows about, enabled or not. Built-ins first.
    static func list(_ config: BackendsConfig?) -> [Backend] {
        builtIn + instances(config).map(asBackend)
    }

    static func isEnabled(_ id: String, _ config: BackendsConfig?) -> Bool {
        !(config?.disabled ?? []).contains(id)
    }

    /// The cards a picker should show.
    ///
    /// `current` is always included even when disabled or unknown: the picker
    /// has to be able to represent the state the session is actually in. Hiding
    /// it would silently redraw the selection as something else. Never returns
    /// an empty list.
    static func available(_ config: BackendsConfig?, current: String? = nil) -> [Backend] {
        let all = list(config)
        let out = all.filter { isEnabled($0.id, config) || $0.id == current }
        return out.isEmpty ? [builtIn[0]] : out
    }

    /// A stored value that names a HARNESS rather than a backend. Every row
    /// written before backends were composable holds one of these.
    static func legacyHarness(_ id: String?) -> String? {
        guard let id else { return nil }
        // The short-lived third backend, folded back into pi as an engine chosen
        // by the mode.
        if id == "omp-rpc" { return "pi-rpc" }
        return customHarnesses.contains(id) ? id : nil
    }

    /// Resolve a stored backend id. Nil when the id names nothing this machine
    /// can run, which the resolver reads as "fall back to the floor".
    static func byId(_ config: BackendsConfig?, _ id: String?) -> Backend? {
        guard let id, !id.isEmpty else { return nil }
        if let exact = list(config).first(where: { $0.id == id }) { return exact }
        guard let harness = legacyHarness(id) else { return nil }
        guard let inherited = instances(config).first(where: {
            $0.harness == harness && isEnabled($0.id, config)
        }) else { return nil }
        return asBackend(inherited)
    }
}

/// `lib/pi-modes.ts` — what the Mode select offers, and what each mode is.
enum PiModes {
    static let all: [String] = [
        "coding", "ops", "omp", "frontend", "consultant", "writer",
        "answer", "scout", "patch", "shell", "web", "office",
    ]
    /// Stored as NULL on agent/session rows. omp (oh-my-pi) is the full-tool engine.
    static let fleetDefault = "omp"

    static func isPiMode(_ v: String?) -> Bool {
        guard let v else { return false }
        return all.contains(v)
    }

    /// Full name plus what the mode actually is, shown under the picker.
    static let meta: [String: (label: String, blurb: String)] = [
        "coding": ("Coding", "Read, write, run. The default working mode for changing a codebase."),
        "ops": ("Ops", "Live machines and services. Investigation discipline, read-before-write, ssh_run."),
        "omp": ("omp (oh-my-pi)", "31 built-in tools: LSP, ast-edit, debug, browser, computer, github, memory."),
        "frontend": ("Frontend", "UI work in a real browser. Screenshot \u{2192} fix \u{2192} re-verify, breakpoints, DOM."),
        "consultant": ("Consultant", "Research-backed advice. Web search, read sources, cited structured replies."),
        "writer": ("Writer", "Long-form prose and copy. Voice, structure, editing passes."),
        "answer": ("Answer", "Think and reply. No repo, no web, no shell \u{2014} the fastest harness there is."),
        "scout": ("Scout", "Read-only investigation. Where is it, how does it work, what calls it."),
        "patch": ("Patch", "Bounded code change. Read, edit, run the check, report the diff."),
        "shell": ("Shell", "Run and inspect things on this machine. Status, logs, processes."),
        "web": ("Web", "Anything that needs the internet. Search, read the page, cite it."),
        "office": ("Office", "Excel, Word and PowerPoint files. Inspect, edit in place, verify, hand back."),
    ]

    /// Falls back to the raw directory name, so a machine-local mode this build
    /// does not list still reads as itself rather than as the default.
    static func label(_ v: String?) -> String {
        if let v, isPiMode(v) { return meta[v]!.label }
        if let v, !v.isEmpty { return v }
        return meta[fleetDefault]!.label
    }

    static func blurb(_ v: String?) -> String? {
        guard let v, isPiMode(v) else { return nil }
        return meta[v]!.blurb
    }
}
