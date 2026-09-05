import Foundation

/// `POST /api/upload` — the one route in this app that is not tRPC.
///
/// It takes `multipart/form-data` with a `sessionId` field and a `file` part,
/// and answers with the url the message should carry. That url is the **safe**
/// one: the route writes a ≤2000px copy beside the original and returns the
/// copy, because handing the model an oversized image wedges its session
/// (evolution/lessons.md L4). Nothing here may ever reach for a different field
/// of that response.
///
/// Written by hand rather than through `HermitAPI` because none of that type
/// applies: no tRPC envelope, no batch wrapper, a body that is not JSON, and a
/// timeout that has to be minutes rather than thirty seconds.
struct AttachUploader {
    /// Scheme + host + port, via the same normaliser the tRPC client uses, so a
    /// `-hermitOrigin` carrying a path cannot put that path in front of
    /// `/api/upload`.
    let root: String
    private let key: () -> String
    private let session: URLSession

    /// A phone on cellular uploading a 12-megapixel photo needs more than the
    /// 30 seconds every other call gets. Long enough to finish on a bad train,
    /// short enough that a black hole still ends as an error chip.
    static let timeout: TimeInterval = 180

    init(origin: URL, key: @escaping () -> String, session: URLSession? = nil) {
        self.root = HermitAPI.rootOf(origin)
        self.key = key
        self.session = session ?? AttachUploader.makeSession()
    }

    /// Same bargain as `HermitAPI.makeSession`, and the same reasons: no
    /// cookies (auth is the header), no cache (the response is a fresh url), no
    /// waiting for connectivity (offline must fail now, visibly, on the chip).
    private static func makeSession() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = timeout
        c.timeoutIntervalForResource = timeout
        c.waitsForConnectivity = false
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        return URLSession(configuration: c)
    }

    /// What `/api/upload` answers with.
    ///
    /// `url` is the only field a send may use. `originalUrl` is deliberately
    /// absent from this type: the route still returns the key so an older
    /// gateway sees a field rather than a hole, but its value is always null
    /// and reading it would be reading a hole.
    struct Uploaded: Decodable, Equatable {
        var url: String
        var mimeType: String
        var width: Int?
        var height: Int?
        /// Present for `kind: "file"`; the server echoes the name it stored.
        var name: String?
        /// A 640px WebP for the chat box, or nil when the encoder was absent or
        /// the source was a GIF. Not read yet — the timeline's image rows are
        /// M4's seventh line — but decoded so it is not silently dropped.
        var thumbUrl: String?
    }

    /// Post one file. Throws `AttachUploadError` with the web's own sentence, so
    /// the error chip reads the same on both clients.
    func upload(sessionId: String, file: PickedFile) async throws -> Uploaded {
        guard let target = URL(string: "\(root)/api/upload") else {
            throw AttachUploadError.badURL("\(root)/api/upload")
        }
        // A boundary that cannot occur inside the body. Random rather than
        // fixed: a fixed one is a real, if remote, way to corrupt an upload of a
        // file that happens to contain it.
        let boundary = "hermit-\(UUID().uuidString)"
        var req = URLRequest(url: target)
        req.httpMethod = "POST"
        req.timeoutInterval = Self.timeout
        req.setValue(key(), forHTTPHeaderField: "x-asst-key")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
        req.httpBody = Self.body(boundary: boundary, sessionId: sessionId, file: file)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw AttachUploadError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            // `upload failed (${r.status}): ${await r.text()}` — the web's exact
            // sentence, because the chip that shows it is the same chip.
            let text = String(data: data, encoding: .utf8) ?? ""
            throw AttachUploadError.rejected(status: status, body: text)
        }
        do {
            return try JSONDecoder().decode(Uploaded.self, from: data)
        } catch {
            throw AttachUploadError.malformed(String(describing: error))
        }
    }

    /// RFC 7578 body: the `sessionId` field, then the file part.
    ///
    /// The filename is written raw, exactly as `FormData.append(name, file)`
    /// does in a browser for an ASCII name. It reaches the server as the part's
    /// `filename`, and the server takes only its EXTENSION — so a name that
    /// needs escaping cannot become a path.
    static func body(boundary: String, sessionId: String, file: PickedFile) -> Data {
        var out = Data()
        func put(_ s: String) { out.append(Data(s.utf8)) }
        put("--\(boundary)\r\n")
        put("Content-Disposition: form-data; name=\"sessionId\"\r\n\r\n")
        put("\(sessionId)\r\n")
        put("--\(boundary)\r\n")
        put("Content-Disposition: form-data; name=\"file\"; filename=\"\(escaped(file.name))\"\r\n")
        put("Content-Type: \(file.mimeType)\r\n\r\n")
        out.append(file.data)
        put("\r\n--\(boundary)--\r\n")
        return out
    }

    /// A quoted-string in a header cannot hold a raw `"`, CR or LF. Browsers
    /// percent-encode those three in `filename`; anything else goes through as
    /// UTF-8, which is what every server in this repo reads it as.
    private static func escaped(_ name: String) -> String {
        name
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
            .replacingOccurrences(of: "\"", with: "%22")
    }
}

/// One thing the reader picked, reduced to what an upload needs.
///
/// Foundation only, so `AttachUploader` never has to see a `PHPickerResult` or
/// a `UIImage`. `AttachPicker` is what turns the platform's answer into this.
struct PickedFile: Equatable {
    /// The filename the picker gave, already through `AttachCore.name`.
    var name: String
    /// What goes in the part's `Content-Type`, and what the server keys its
    /// image / non-image branch off.
    var mimeType: String
    /// `file.type.startsWith('image/')` — the web's own test, and the one the
    /// cap arithmetic reads.
    var isImage: Bool
    var data: Data
    /// Read on the device, in parallel with the upload, exactly as the web
    /// reads them in the browser: the server tries `sips`/`identify` too, but
    /// those may be absent on the deploy box, and the local read is what keeps
    /// the chip from saying `image` when it knows better.
    var width: Int?
    var height: Int?
}

/// Why an upload did not land. `errorDescription` is what the chip prints, and
/// it is the web's wording rather than Foundation's.
enum AttachUploadError: LocalizedError, Equatable {
    case badURL(String)
    case transport(String)
    case rejected(status: Int, body: String)
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .badURL(let u): return "bad upload url: \(u)"
        case .transport(let m): return m
        case .rejected(let status, let body): return "upload failed (\(status)): \(body)"
        case .malformed(let m): return "upload answered with something else: \(m)"
        }
    }
}
