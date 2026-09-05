import Foundation

/// The `+` button's pure decisions, ported from
/// `apps/dashboard/src/components/chat/attach-core.ts`.
///
/// What may be attached, how many of it, what the chip under each one reads,
/// and what the caption above the box counts. Every answer here is held against
/// the web's own by `tools/attach-fixture.sh`, so where the web is surprising
/// the surprise is copied and the fixture is what proves it was copied rather
/// than reasoned about.
///
/// Sibling of `ComposerCore` (the box's decisions) and `QueueCore` (the strip's).
/// Foundation only — no UIKit, no SwiftUI, nothing that needs a screen, and
/// nothing that needs a file: a candidate is described by its NAME and whether
/// the picker called it an image, which is all any of this reads.
enum AttachCore {

    // MARK: - What may be attached

    /// Non-image extensions `/api/upload` accepts.
    ///
    /// Order matters only for `fileAccept`, which is compared against the web's
    /// string in the fixture — so a reordering here is caught, not tolerated.
    /// Archives, office documents, audio and video are all on the list and none
    /// of them is ever `Read` by the agent: the gateway hands it a Bash
    /// instruction (unzip / textutil / whisper / ffmpeg) instead.
    static let safeFileExts: [String] = [
        // text & docs
        "txt", "md", "markdown", "rtf", "log", "pdf",
        // data / config
        "json", "yaml", "yml", "toml", "ini", "conf", "env", "xml", "html", "svg", "csv", "tsv", "sql",
        // source
        "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "php", "go", "rs",
        "c", "cpp", "cc", "cxx", "h", "hpp", "java", "kt", "swift", "scala", "clj", "ex", "exs",
        "sh", "bash", "zsh", "fish", "ps1", "dart", "lua", "r",
        // archives — stored as-is; the agent extracts them via Bash (never Read'd)
        "zip", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "7z", "rar", "zst",
        // office docs — converted agent-side via Bash (textutil / python / unzip)
        "docx", "xlsx", "pptx", "doc", "xls", "ppt", "odt", "ods", "odp",
        // audio — stored as-is; the agent transcribes / inspects via Bash
        "mp3", "m4a", "wav", "ogg", "flac", "aac",
        // video — stored as-is; the agent inspects / extracts frames via Bash
        "mp4", "mov", "m4v", "webm", "mkv", "avi", "mpeg", "mpg", "3gp", "wmv",
    ]

    static let safeFileExtSet = Set(safeFileExts)

    /// The web's `<input accept>` value. Carried because it is the one place the
    /// list's ORDER is observable, and therefore the one thing that can prove
    /// the two lists are the same list rather than the same set.
    static let fileAccept = "image/*," + safeFileExts.map { "." + $0 }.joined(separator: ",")

    /// Per-message caps — these MUST match `chat.send`'s zod `.max(...)`.
    /// Enforced here so extras are skipped with a visible notice: `chat.send`
    /// refuses the WHOLE message if either is over, so one image too many would
    /// sink the typed text along with it.
    static let maxImages = 20
    static let maxFiles = 10

    /// The extension, lowercased, with no dot — `""` when there is no dot.
    ///
    /// The web takes the LAST dot anywhere (`name.lastIndexOf('.')`), so
    /// `.bashrc` reads as `bashrc` and is refused by name. Swift's
    /// `NSString.pathExtension` would answer `""` there, and `(name as
    /// NSString).pathExtension` also strips a trailing dot — neither is what the
    /// composer does, so this is written out.
    static func ext(of name: String) -> String {
        guard let dot = name.lastIndex(of: ".") else { return "" }
        return String(name[name.index(after: dot)...]).lowercased()
    }

    /// Whether a non-image file may be uploaded at all. Images never come here.
    static func isSafeFileName(_ name: String) -> Bool {
        safeFileExtSet.contains(ext(of: name))
    }

    /// The error a refused file's chip carries. The server's 415 says the same.
    static func unsupportedTypeError(_ name: String) -> String {
        let e = ext(of: name)
        return "unsupported file type" + (e.isEmpty ? "" : " (.\(e))")
    }

    /// What a candidate is called. An empty name means something handed us an
    /// image with no filename, which is the ordinary way a screenshot arrives.
    static func name(_ raw: String, isImage: Bool) -> String {
        raw.isEmpty ? (isImage ? "pasted-image" : "file") : raw
    }

    // MARK: - How many

    enum Kind: String, Codable, Equatable {
        case uploading, ready, error
    }

    /// One attachment already in the composer, as the cap arithmetic sees it.
    struct Slot: Equatable {
        var kind: Kind
        var isImage: Bool
        init(kind: Kind, isImage: Bool) {
            self.kind = kind
            self.isImage = isImage
        }
    }

    /// How many of each cap are spoken for.
    ///
    /// An `error` chip does NOT hold a slot — it is a thing that failed, and
    /// refusing the next pick because of it would make a rejected file cost the
    /// reader an image.
    static func occupiedSlots(_ existing: [Slot]) -> (images: Int, files: Int) {
        var images = 0
        var files = 0
        for a in existing where a.kind != .error {
            if a.isImage { images += 1 } else { files += 1 }
        }
        return (images, files)
    }

    /// What `admit` decided.
    struct Admission: Equatable {
        /// Indexes INTO the batch, so a caller holding real picker results gets
        /// its own objects back.
        var accepted: [Int]
        /// The amber strip's sentence, or nil to clear it.
        var notice: String?
    }

    /// Which of a batch of picked / pasted / dropped files may be added, and
    /// what to say about the ones that may not.
    ///
    /// The caps apply IN ORDER, so a pick of thirty photos keeps the first
    /// twenty rather than an arbitrary twenty; the two budgets are independent,
    /// so a pick of thirty photos and one PDF still takes the PDF.
    static func admit(_ incoming: [Bool], existing: [Slot]) -> Admission {
        let live = occupiedSlots(existing)
        var imgSlots = maxImages - live.images
        var fileSlots = maxFiles - live.files
        var accepted: [Int] = []
        var droppedImg = 0
        var droppedFile = 0
        for (i, isImage) in incoming.enumerated() {
            if isImage {
                if imgSlots > 0 { accepted.append(i); imgSlots -= 1 } else { droppedImg += 1 }
            } else if fileSlots > 0 {
                accepted.append(i)
                fileSlots -= 1
            } else {
                droppedFile += 1
            }
        }
        if droppedImg == 0 && droppedFile == 0 { return Admission(accepted: accepted, notice: nil) }
        var parts: [String] = []
        if droppedImg > 0 {
            parts.append("\(droppedImg) image\(droppedImg > 1 ? "s" : "") (max \(maxImages) per message)")
        }
        if droppedFile > 0 {
            parts.append("\(droppedFile) file\(droppedFile > 1 ? "s" : "") (max \(maxFiles) per message)")
        }
        return Admission(accepted: accepted, notice: "Skipped \(parts.joined(separator: " and ")).")
    }

    // MARK: - The caption

    /// One half of the caption under the chips. `atCap` is the amber one.
    struct CapSegment: Equatable {
        var text: String
        var atCap: Bool
    }

    /// The separator between the two halves.
    static let capsSeparator = " · "

    /// `3/20 images · 1/10 files` — but only the halves that have anything in
    /// them, and only at all once something is attached. A composer with no
    /// attachments does not explain a limit nobody is near.
    static func capsCaption(images: Int, files: Int) -> [CapSegment] {
        var out: [CapSegment] = []
        if images > 0 { out.append(CapSegment(text: "\(images)/\(maxImages) images", atCap: images >= maxImages)) }
        if files > 0 { out.append(CapSegment(text: "\(files)/\(maxFiles) files", atCap: files >= maxFiles)) }
        return out
    }

    // MARK: - What a chip says

    /// A finished upload, as its sub-label reads it.
    struct Ready: Equatable {
        var isImage: Bool
        var name: String
        var mimeType: String
        var width: Int?
        var height: Int?
    }

    /// The sub-label under a finished attachment's filename: real pixel
    /// dimensions for an image, a type hint for everything else — never a bogus
    /// `?×?`.
    ///
    /// The web guards with `if (a.width && a.height)`, which is falsy for zero
    /// as well as for null; a zero-dimension image is a decode that failed, and
    /// printing `0×0` would be worse than saying `image`. Hence the `!= 0`.
    static func readyLabel(_ a: Ready) -> String {
        if let w = a.width, let h = a.height, w != 0, h != 0 { return "\(w)×\(h)" }
        if a.isImage { return "image" }
        // `mimeType.split('/')[1]`: nil when there is no slash, "" when there is
        // nothing after it. Both are falsy on the web, so both fall through.
        let parts = a.mimeType.split(separator: "/", omittingEmptySubsequences: false)
        if parts.count > 1 {
            let sub = String(parts[1])
            if !sub.isEmpty && sub != "octet-stream" { return sub }
        }
        // `name.split('.').pop()` — the LAST segment, and deliberately not
        // lowercased: this is a label, not a lookup.
        guard a.name.contains(".") else { return "file" }
        let last = String(a.name.split(separator: ".", omittingEmptySubsequences: false).last ?? "")
        return last.isEmpty ? "file" : last
    }

    /// What a chip's second line says, whatever state it is in.
    enum ChipState: Equatable {
        case uploading
        case failed(String)
        case ready(Ready)
    }

    static func chipSubLabel(_ s: ChipState) -> String {
        switch s {
        case .uploading:
            return "uploading…"
        case .failed(let e):
            // `error.slice(0, 40)` — UTF-16 code units, which is what a JS
            // string index counts. Cutting by Character instead would keep a
            // 41st unit whenever the 40th is half of a surrogate pair.
            return String(decoding: Array(e.utf16.prefix(40)), as: UTF16.self)
        case .ready(let r):
            return readyLabel(r)
        }
    }
}
