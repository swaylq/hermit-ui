import Foundation

/// The chat header's vocabulary, ported from the web.
///
/// Five small functions that between them decide every string on the header's
/// meta line: how many tokens (`fmtBytes`), out of how many (`contextWindowFor`),
/// how full that is (`ctxPct`), which harness is running the turn
/// (`runtimeShortLabel`) and whose endpoint answers (`providerMark`).
///
/// Sibling of `WebFormat` in `SessionListItem.swift`, which holds the same kind
/// of thing for the session list. Kept apart from it only because these five are
/// what the header needs and that one is what a row needs; both are ports, both
/// are Foundation-only, and both are held against the web by a generated table
/// (`tools/header-fixture.sh` and `tools/status-fixture.sh` respectively).
///
/// Nothing here judges anything. Where the web is surprising — `!n` catching
/// zero, `toFixed` rounding a tie the other way from C, `slice` counting UTF-16
/// code units rather than characters — the surprise is copied, and the fixture
/// is what proves it was copied rather than reasoned about.
enum WebLabels {

    // MARK: - lib/format.ts

    /// JavaScript's `Number.prototype.toFixed`, which is neither
    /// `String(format:)` nor "scale, round, divide".
    ///
    /// ECMA-262 defines it on the EXACT value of the binary double: pick the
    /// integer `n` for which `n / 10^f - x` is closest to zero, and on a tie
    /// pick the LARGER n. Two ways to get that wrong, and this port made the
    /// second one first:
    ///
    ///   · `String(format: "%.1f")` is C, which rounds a tie to EVEN. 1250
    ///     tokens print `1.3k` in the browser and `1.2k` here. Same trap
    ///     `RunLabel.chars` hit in round 20.
    ///   · Rounding `(x * 10).rounded(.toNearestOrAwayFromZero)` introduces a
    ///     multiplication that is itself rounded. 1150 / 1000 is really
    ///     1.14999999999999991…, which `toFixed(1)` reads as 1.1 — but times ten
    ///     it lands exactly on 11.5, and away-from-zero then says 1.2. The
    ///     fixture caught both 1150 and 1450 the first time it ran.
    ///
    /// So the digits are taken from the double's own decimal expansion, which
    /// `%.30f` prints exactly, and the rounding decision is read off the first
    /// digit past the cut. Thirty places is far more than any value this is
    /// given (a token count over a thousand) can need to settle a tie.
    static func jsToFixed(_ x: Double, _ digits: Int) -> String {
        guard x.isFinite else { return "\(x)" }
        let exact = String(format: "%.30f", abs(x))
        let halves = exact.split(separator: ".", maxSplits: 1)
        var whole = Array(halves[0])
        var frac = Array(halves.count > 1 ? Array(halves[1]) : [])
        while frac.count < digits + 1 { frac.append("0") }
        var kept = Array(frac[0..<digits])
        // "…and on a tie pick the larger n": at or above five rounds up, which
        // is the whole difference from C's round-half-to-even.
        if frac[digits] >= "5" {
            var i = kept.count - 1
            var carry = true
            while carry && i >= 0 {
                if kept[i] == "9" { kept[i] = "0"; i -= 1 }
                else { kept[i] = Character(String(Int(String(kept[i]))! + 1)); carry = false }
            }
            if carry {
                var j = whole.count - 1
                while carry && j >= 0 {
                    if whole[j] == "9" { whole[j] = "0"; j -= 1 }
                    else { whole[j] = Character(String(Int(String(whole[j]))! + 1)); carry = false }
                }
                if carry { whole.insert("1", at: 0) }
            }
        }
        let body = digits > 0 ? "\(String(whole)).\(String(kept))" : String(whole)
        let isZero = whole.allSatisfy { $0 == "0" } && kept.allSatisfy { $0 == "0" }
        return (x < 0 && !isZero ? "-" : "") + body
    }

    /// `lib/format.ts` `fmtBytes`. Four tiers, `-` for nothing at all.
    ///
    /// The B tier is not decoration — the comment on the original says a
    /// machine's cache-read tokens run to ~10B over two weeks, which printed as
    /// `10641.71M` before it existed. A session's context never gets there, but
    /// this is the same function and it comes across whole.
    static func fmtBytes(_ n: Int?) -> String {
        guard let n else { return "-" }
        let d = Double(n)
        if n >= 1_000_000_000 { return "\(jsToFixed(d / 1_000_000_000, 2))B" }
        if n >= 1_000_000 { return "\(jsToFixed(d / 1_000_000, 2))M" }
        if n >= 1_000 { return "\(jsToFixed(d / 1_000, 1))k" }
        return String(n)
    }

    /// `lib/format.ts` `ctxPct`, capped at 100.
    ///
    /// `if (!n) return 0` catches zero as well as absent, so a session with a
    /// genuine 0 tokens and one that has never completed a turn both read 0 —
    /// the difference is carried by the caller, which prints `—` for the second.
    static func ctxPct(_ n: Int?, total: Int) -> Double {
        guard let n, n != 0 else { return 0 }
        return min(100, (Double(n) / Double(total)) * 100)
    }

    /// `components/ctx-bar.tsx` via `lib/format.ts` `ctxFill`. How wide the
    /// fill is drawn, which is NOT the percentage: floored at 2 so a session
    /// that has used something reads as a sliver rather than as an empty track.
    static func ctxFill(_ pct: Double) -> Double {
        max(2, min(100, pct))
    }

    // MARK: - lib/context-window.ts

    /// Claude Opus 5's window, and the historical default for every backend.
    static let defaultContextWindow = 1_000_000
    static let codexDefaultWindow = 258_400
    static let kimiDefaultWindow = 262_144

    /// Longest matching PREFIX wins, so a dated or suffixed release resolves
    /// without an entry of its own. Both tables are ordered longest-first on the
    /// web and the order is kept here — `first(where:)` is not `max(by:)`.
    private static let codexWindows: [(prefix: String, window: Int)] = [
        ("gpt-5.3-codex-spark", 121_600),
        // The fleet default. Listed rather than left to the fallback for the
        // reason the web gives: the model everything actually runs on landing on
        // the "never heard of it" branch reads like an oversight.
        //
        // Worth knowing that the fixture cannot catch this row going missing —
        // every codex entry but the spark one carries the same number the
        // fallback does, so today the whole table is bookkeeping. It stops being
        // bookkeeping the first time one of these windows differs, and that is
        // the day a stale table would start lying.
        ("gpt-6", 258_400),
        ("gpt-5.6", 258_400),
        ("gpt-5.5", 258_400),
        ("gpt-5.4", 258_400),
    ]

    private static let kimiWindows: [(prefix: String, window: Int)] = [
        ("k3-256k", 262_144),
        ("kimi-for-coding", 262_144),
        ("k3", 1_048_576),
    ]

    static func codexContextWindow(_ model: String?) -> Int {
        let id = jsTrim(model ?? "").lowercased()
        if id.isEmpty { return codexDefaultWindow }
        return codexWindows.first { id.hasPrefix($0.prefix) }?.window ?? codexDefaultWindow
    }

    static func kimiContextWindow(_ model: String?) -> Int {
        let id = jsTrim(model ?? "").lowercased()
        if id.isEmpty { return kimiDefaultWindow }
        return kimiWindows.first { id.hasPrefix($0.prefix) }?.window ?? kimiDefaultWindow
    }

    /// The denominator under the context bar. Anything not named here takes the
    /// 1M default, including `pi-rpc`, deliberately: pi's real window varies per
    /// machine-configured model and the gateway has no route to tell the client,
    /// so guessing here would be the same class of bug the file was written to
    /// fix.
    static func contextWindowFor(runtime: String?, model: String? = nil) -> Int {
        if runtime == "codex-exec" { return codexContextWindow(model) }
        if runtime == "kimi-code" { return kimiContextWindow(model) }
        return defaultContextWindow
    }

    // MARK: - lib/runtime-labels.ts

    /// Short name for the chat header, where the meta line is tight at 390px.
    /// Anything unrecognised — including nil — reads `Claude`, which is the
    /// web's fallback and not a guess: in a mixed fleet "no badge" would be
    /// ambiguous between Claude Code and a header that has not loaded.
    static func runtimeShortLabel(_ kind: String?) -> String {
        switch kind {
        case "pi-rpc": return "pi"
        case "prime-rpc": return "prime"
        case "codex-exec": return "Codex"
        case "dsh-exec": return "dsh"
        case "kimi-code": return "Kimi"
        default: return "Claude"
        }
    }

    /// Pretty names for the endpoints a credential can point at. Keyed on the
    /// credential's `provider`, which is free text typed in Settings → Models —
    /// a spelling table, not a registry.
    private static let providerMarks: [String: String] = [
        "kimi-coding": "Kimi",
        "moonshotai-cn": "Kimi",
        "moonshotai": "Kimi",
        "moonshot": "Kimi",
        "kimi": "Kimi",
        "zai": "GLM",
        "openrouter": "OpenRouter",
        "deepseek": "DeepSeek",
    ]

    /// Whose model answers, for a session running on a credential. Nil when
    /// there is nothing to say.
    ///
    /// The tail cut is `p.length > 12 ? p.slice(0, 11) + '…' : p`, and both of
    /// those count UTF-16 CODE UNITS. Swift's `count` counts graphemes, so a
    /// provider name with an emoji or a combining mark in it cuts at a different
    /// place unless the port says `utf16` out loud — see the fixture's
    /// `provider` section, which exists for exactly this.
    static func providerMark(_ provider: String?) -> String? {
        let p = jsTrim(provider ?? "")
        if p.isEmpty { return nil }
        if let named = providerMarks[p.lowercased()] { return named }
        let units = Array(p.utf16)
        guard units.count > 12 else { return p }
        return String(decoding: units[0..<11], as: UTF16.self) + "…"
    }

    /// `String.prototype.trim`, which strips the JS whitespace set — ASCII
    /// space/tab/newlines plus Unicode space separators, BOM and the line/
    /// paragraph separators. Foundation's `.whitespacesAndNewlines` is close but
    /// does not include U+FEFF, and the provider column is free text.
    private static func jsTrim(_ s: String) -> String {
        var set = CharacterSet.whitespacesAndNewlines
        set.insert(charactersIn: "\u{FEFF}")
        return s.trimmingCharacters(in: set)
    }
}
