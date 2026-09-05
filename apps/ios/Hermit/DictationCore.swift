import Foundation

/// What the words ARE — the pure half of realtime dictation, with no socket and
/// no microphone in sight.
///
/// The Swift half of two web modules, kept together because on the phone they
/// are one thing:
///
/// * `apps/dashboard/src/lib/dictation-text.ts` — joining closed sentences, and
///   the claim a run holds on the draft.
/// * `apps/dashboard/src/lib/asr-reduce.ts` — folding the socket's frames into
///   the three layers of text.
///
/// Both sides are run over one table by `tools/hold-fixture.sh`.
///
/// ## The two mistakes this file exists to make visible
///
/// **A welded-together word.** ASR punctuates its own output, so sentences abut
/// directly and a space between them would be wrong in Chinese — except at the
/// seam where one sentence ends and the next begins with Latin word characters.
/// "restart" + "then check" welded together is a different word.
///
/// **A run quietly eating text the user typed while it was running.** `foldTail`
/// rebases when the draft has moved under it; `replaceTail`, which looks
/// identical, DROPS. Getting that pair backwards loses a sentence with no error
/// anywhere.

// MARK: - Joining sentences

enum DictationText {
    /// Join closed sentences into the text that belongs in the draft.
    static func joinSegments(_ texts: [String]) -> String {
        var out = ""
        for t in texts where !t.isEmpty {
            if let a = out.last, let b = t.first, isWordChar(a), isWordChar(b) { out += " " }
            out += t
        }
        return out
    }

    /// `[A-Za-z0-9]` — the web's character class, exactly. Deliberately ASCII:
    /// `Character.isLetter` would call 「重」 a word character and start inserting
    /// spaces into Chinese.
    private static func isWordChar(_ c: Character) -> Bool {
        c.isASCII && (c.isLetter || c.isNumber)
    }

    /// JavaScript's `String.prototype.trimEnd`.
    static func trimEnd(_ s: String) -> String {
        var out = Substring(s)
        while let last = out.last, last.isWhitespace { out = out.dropLast() }
        return String(out)
    }
}

/// A dictation run's claim on the draft: everything after `base` is ours to
/// rewrite.
///
/// `base == nil` means the run hasn't put a character in yet, so the base is
/// still whatever the user will have typed by the time the first sentence lands
/// — which is why it is resolved lazily instead of at run start.
struct DictationClaim: Equatable {
    /// Text that is the user's, in front of ours.
    var base: String?
    /// Exactly what was last written, which is not always `base + tail`: an empty
    /// tail renders as `base` with its separator trimmed, so cancelling a run
    /// gives back the user's own text rather than their text plus a stray space.
    /// Storing what we rendered — rather than recomputing it — is what keeps the
    /// "did the user edit this?" check honest.
    var rendered: String

    static func new() -> DictationClaim { DictationClaim(base: nil, rendered: "") }
}

extension DictationText {
    /// Fold a new tail into the current draft.
    ///
    /// The invariant is `draft == base + tail`. When it doesn't hold, the user
    /// typed or edited while dictating — and THEIR TEXT WINS: the draft as it
    /// stands becomes the new base and the tail grows after it, rather than
    /// overwriting what they just wrote. That is the whole reason the tail is
    /// rewritten wholesale instead of patched by offset: corrections come back
    /// out of order, so there is no offset arithmetic to get wrong, and one
    /// string comparison catches every interference.
    static func foldTail(_ claim: DictationClaim, draft: String, tail: String)
        -> (draft: String, claim: DictationClaim) {
        // Nothing dictated yet and nothing to dictate — leave the draft alone
        // rather than materialising a separator the user never asked for.
        if claim.base == nil && tail.isEmpty { return (draft, claim) }

        let intact = claim.base != nil && draft == claim.rendered
        var base = claim.base
        if !intact {
            let head = trimEnd(draft)
            base = head.isEmpty ? "" : head + " "
        }
        let b = base ?? ""
        let rendered = tail.isEmpty ? trimEnd(b) : b + tail
        return (rendered, DictationClaim(base: b, rendered: rendered))
    }

    /// Swap a finished run's whole tail for the corrected passage — the
    /// end-of-run refine landing.
    ///
    /// Deliberately NOT `foldTail`. That one rebases when the draft has moved
    /// under it, because the tail it folds is still GROWING: words arriving after
    /// the user typed must land after what they typed. A refine is the opposite
    /// shape — it REPLACES text already on the screen — so "the draft moved"
    /// cannot mean "append after it". That would leave the passage in the draft
    /// twice. It means this correction is stale, and stale corrections are
    /// dropped: the user's draft is the newer of the two.
    static func replaceTail(_ claim: DictationClaim, draft: String, tail: String)
        -> (draft: String, claim: DictationClaim, applied: Bool) {
        guard let base = claim.base, draft == claim.rendered else { return (draft, claim, false) }
        let rendered = tail.isEmpty ? trimEnd(base) : base + tail
        return (rendered, DictationClaim(base: base, rendered: rendered), true)
    }

    // Both counts are in UTF-16 units, which is what JavaScript's `.length` is —
    // and the unit that matters is the CJK one, where the two agree. A dictated
    // Chinese sentence runs 8–15 characters, so 16 is "more than one thing was
    // said" and 36 is a paragraph's worth.
    private static let refineMinChars = 16
    private static let refineLongChars = 36
    /// What ASR puts between two pauses. Each one is a place the meaning may be cut.
    private static let sentenceBreaks: Set<Character> = ["。", "．", ".", "！", "!", "？", "?", "；", ";", "\n"]

    /// Is this passage worth a whole-passage correction pass?
    ///
    /// The pass costs a round trip and a visible half-second at the end of a run,
    /// so it should not run on 「继续」. What it is FOR is the seam between
    /// sentences — so the trigger is that there were seams: two or more closed
    /// sentences, which means per-sentence polish ran at least twice with no idea
    /// of the other. One long sentence qualifies too (it can be mangled
    /// internally), a short one never.
    static func worthRefining(_ passage: String) -> Bool {
        let text = passage.trimmingCharacters(in: .whitespacesAndNewlines)
        let n = text.utf16.count
        if n < refineMinChars { return false }
        if n >= refineLongChars { return true }
        return text.filter { sentenceBreaks.contains($0) }.count >= 2
    }
}

// MARK: - The socket's frames

/// One closed sentence, and whether its correction is still outstanding.
struct AsrSeg: Equatable {
    var id: Int
    var text: String
    var polishing: Bool
}

/// Everything the reducer remembers.
struct AsrModel: Equatable {
    var segs: [AsrSeg] = []
    var partial: String = ""
}

/// The three layers, as the caller needs them.
///
/// They are reported separately rather than pre-joined because when the socket
/// dies, only the CLOSED sentences may stay in the draft: the partial's audio is
/// about to be re-transcribed by the batch fallback, and leaving it would
/// deliver it twice.
struct DictationState: Equatable {
    /// Unstable sentence-in-progress.
    var partial: String
    /// Closed sentences, joined — this is what belongs in the draft.
    var tail: String
    /// Sentences still being corrected.
    var pending: Int
}

/// What the caller must do about this frame, beyond redrawing.
enum AsrEffect: Equatable {
    case none
    /// The ASR task is live; audio is being transcribed.
    case ready
    /// A sentence closed — the capture layer's fallback buffer for it can go.
    case sentence
    /// The server finished; the tail is final.
    case done
    /// The socket is unusable; the caller falls back to the batch route.
    case fail(String)
}

enum AsrReduce {
    static func state(_ m: AsrModel) -> DictationState {
        DictationState(partial: m.partial,
                       tail: DictationText.joinSegments(m.segs.map(\.text)),
                       pending: m.segs.filter(\.polishing).count)
    }

    /// Fold one frame in.
    ///
    /// Pure: `m` is not touched. Anything unparseable, of an unknown type, or
    /// addressed to a segment that was never opened is IGNORED — the dashboard
    /// ships continuously and this shell ships through TestFlight, so a server
    /// that learned a frame before the client did is the normal case and must
    /// degrade to silence rather than to a wrong transcript.
    ///
    /// One deliberate narrowing against the web: a `text` that is not a string
    /// and a `segId` that is not a whole number are treated as absent, where
    /// JavaScript would carry the value through untyped. The server sends
    /// neither, and the alternative is putting a number in the draft.
    static func step(_ m: AsrModel, _ raw: String) -> (model: AsrModel, effect: AsrEffect) {
        guard let data = raw.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let msg = any as? [String: Any]
        else { return (m, .none) }

        let type = msg["type"] as? String
        let text = msg["text"] as? String

        switch type {
        case "ready":
            return (m, .ready)

        case "partial":
            return (AsrModel(segs: m.segs, partial: text ?? ""), .none)

        case "final":
            // No id, no address — and a sentence we cannot address is one no
            // correction could ever replace, so it is dropped rather than appended.
            guard let n = msg["segId"] as? NSNumber, let id = Int(exactly: n.doubleValue) else {
                return (m, .none)
            }
            var segs = m.segs
            segs.append(AsrSeg(id: id, text: text ?? "", polishing: true))
            return (AsrModel(segs: segs, partial: ""), .sentence)

        case "polished":
            guard let n = msg["segId"] as? NSNumber, let id = Int(exactly: n.doubleValue),
                  let i = m.segs.firstIndex(where: { $0.id == id })
            else { return (m, .none) }
            var segs = m.segs
            // A correction that came back empty is not a correction to an empty
            // sentence, it is a correction that failed. Keep what we had.
            segs[i] = AsrSeg(id: segs[i].id, text: text ?? segs[i].text, polishing: false)
            return (AsrModel(segs: segs, partial: m.partial), .none)

        case "done":
            // Nothing is still being corrected by the time the server says done.
            let segs = m.segs.map { AsrSeg(id: $0.id, text: $0.text, polishing: false) }
            return (AsrModel(segs: segs, partial: ""), .done)

        case "error":
            let fatal = (msg["fatal"] as? NSNumber)?.boolValue ?? false
            guard fatal else { return (m, .none) }
            return (m, .fail((msg["message"] as? String) ?? "ASR failed"))

        default:
            return (m, .none)
        }
    }
}
