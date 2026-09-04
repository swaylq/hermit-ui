import Foundation

/// tRPC over HTTP, hand-written. The first native network code in this app.
///
/// **This does not change the credential red line.** `HermitAPI` never reads the
/// Keychain and never picks a key: it calls a closure the caller hands it. Nothing
/// in the shell constructs one yet, so today the shell still makes no
/// authenticated request of its own — which is what `README.md` and
/// `NativeBridge.swift` say. Wiring `Keychain.read` into that closure is a
/// separate decision (docs/ios-native-progress.md, "A2 的重试由谁发出去") and it
/// belongs in the call site, not here.
///
/// ## The wire format
///
/// tRPC's own client is a pile of links and transformers; the format underneath
/// it is four lines, and this repo already speaks it by hand in two other places
/// (`apps/gateway/src/api.ts` and `apps/dashboard/src/app/providers.tsx`):
///
/// ```
/// query     GET  /api/trpc/<proc>?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D
/// mutation  POST /api/trpc/<proc>?batch=1     body: {"0":{"json":{…}}}
/// both      header: x-asst-key: <key>
/// success   j[0].result.data.json
/// failure   j[0].error.json.{message,data.code}
/// ```
///
/// `batch=1` is not optional even for a single call: it is what makes the server
/// answer with the one-element ARRAY this parses. Drop it and every response
/// shape below is wrong.
///
/// ## superjson is not implemented, on purpose
///
/// The dashboard runs tRPC with the superjson transformer, so every payload is
/// `{json, meta}`. `meta` exists to rebuild JS types that JSON cannot carry —
/// and in this repo the only such type is `Date`, which superjson writes into
/// `json` as a plain `toISOString()` string. Swift is statically typed, so
/// declaring the field `Date` and decoding ISO-8601 gets the same result without
/// a line of transformer code; `meta` is ignored wholesale.
///
/// That shortcut is safe only while no procedure returns a `Map`, `Set`, `BigInt`,
/// `undefined` or `NaN` — those live in `meta` alone and would decode as garbage
/// or as a missing key. None appear in `apps/dashboard/src/server/routers/`
/// today. Inputs are the easy direction: `grep -rn 'z\.date()'` over the routers
/// finds nothing, so no procedure wants a `Date` on the way in and the encoder
/// below never has to emit `meta`.
struct HermitAPI {
    /// Where the requests go. Only the scheme, host and port are used — a path,
    /// query or fragment is dropped, because `-hermitOrigin` is allowed to carry
    /// a route (`…:4102/push`, see `AppConfig.launchArgumentOrigin`) and that
    /// route must not end up in front of `/api/trpc`.
    let root: String

    /// Read fresh on every request and never stored, the same contract
    /// `authedFetch` has on the web (`apps/dashboard/src/lib/asst-fetch.ts`):
    /// the active machine can change under a long-lived client.
    private let key: () -> String

    private let session: URLSession

    /// Hard ceiling on every call. Without one a hung connection never settles,
    /// and any caller holding a `busy` flag across the await wedges forever —
    /// the same 30s the gateway settled on (`apps/gateway/src/api.ts`).
    static let timeout: TimeInterval = 30

    init(origin: URL, key: @escaping () -> String, session: URLSession? = nil) {
        self.root = HermitAPI.rootOf(origin)
        self.key = key
        self.session = session ?? HermitAPI.makeSession()
    }

    /// A session of our own rather than `URLSession.shared`.
    ///
    /// - No cookies. Auth here is the `x-asst-key` header and nothing else, so a
    ///   cookie jar could only ever attach something we did not intend to send.
    /// - No cache. Every one of these responses is live state; a 304 from a
    ///   stale validator would show yesterday's session list.
    /// - `waitsForConnectivity = false`: offline must fail NOW. The outbound
    ///   queue (M1 A2) decides when to retry; a request parked by the OS for
    ///   minutes is indistinguishable from a hang to everything above it.
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

    // MARK: - Calls

    /// A query taking no input — `{"0":{"json":null}}`, which is what tRPC's own
    /// client sends for a `void` procedure and what `z.preprocess` on the server
    /// is written to tolerate (`chat.listSessions`).
    func query<Out: Decodable>(_ path: String, as out: Out.Type) async throws -> Out {
        try await send(path, method: "GET", envelope: try Self.envelope(Never?.none), as: out)
    }

    func query<In: Encodable, Out: Decodable>(_ path: String, input: In, as out: Out.Type) async throws -> Out {
        try await send(path, method: "GET", envelope: try Self.envelope(input), as: out)
    }

    func mutate<Out: Decodable>(_ path: String, as out: Out.Type) async throws -> Out {
        try await send(path, method: "POST", envelope: try Self.envelope(Never?.none), as: out)
    }

    func mutate<In: Encodable, Out: Decodable>(_ path: String, input: In, as out: Out.Type) async throws -> Out {
        try await send(path, method: "POST", envelope: try Self.envelope(input), as: out)
    }

    // MARK: - Transport

    private func send<Out: Decodable>(
        _ path: String, method: String, envelope: Data, as out: Out.Type
    ) async throws -> Out {
        var url = "\(root)/api/trpc/\(path)?batch=1"
        if method == "GET" {
            // The envelope rides in the query string, so it has to survive being
            // one. `percentEncoded` is encodeURIComponent, not `urlQueryAllowed`
            // — the latter leaves `&`, `=`, `+` and `/` alone, and an input
            // containing any of them would silently become a different request.
            guard let s = String(data: envelope, encoding: .utf8) else {
                throw HermitAPIError.malformed("input is not UTF-8")
            }
            url += "&input=" + Self.percentEncoded(s)
        }
        guard let target = URL(string: url) else { throw HermitAPIError.badURL(url) }

        var req = URLRequest(url: target)
        req.httpMethod = method
        req.timeoutInterval = Self.timeout
        req.setValue(key(), forHTTPHeaderField: "x-asst-key")
        req.setValue("application/json", forHTTPHeaderField: "accept")
        if method != "GET" {
            req.httpBody = envelope
            req.setValue("application/json", forHTTPHeaderField: "content-type")
        }

        // URLError propagates as itself — offline, DNS, timeout and cancellation
        // all carry a `code` the caller can branch on, and wrapping it in one of
        // ours would throw that away.
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0

        // The tRPC error body first, HTTP status second: a 401 whose body says
        // "invalid key" should surface that sentence, not the number. A body
        // that is not tRPC at all (an nginx 502 page) falls through to the
        // status branch.
        if let rpc = Self.rpcError(in: data, status: status) { throw rpc }
        guard (200..<300).contains(status) else {
            throw HermitAPIError.http(status: status, body: Self.preview(data))
        }

        let decoded: [Batch<Out>]
        do {
            decoded = try Self.decoder.decode([Batch<Out>].self, from: data)
        } catch {
            throw HermitAPIError.malformed("\(path): \(error)")
        }
        guard let json = decoded.first?.result?.data.json else {
            throw HermitAPIError.malformed("\(path): no result in a \(decoded.count)-entry batch")
        }
        return json
    }

    // MARK: - Envelope

    private struct Envelope<In: Encodable>: Encodable {
        let input: In?
        private enum Outer: String, CodingKey { case zero = "0" }
        private enum Inner: String, CodingKey { case json }
        func encode(to encoder: Encoder) throws {
            var outer = encoder.container(keyedBy: Outer.self)
            var inner = outer.nestedContainer(keyedBy: Inner.self, forKey: .zero)
            // An explicit null, not an omitted key: tRPC reads `json` as the
            // argument and a missing key means "no argument at index 0", which
            // is a different request.
            if let input { try inner.encode(input, forKey: .json) } else { try inner.encodeNil(forKey: .json) }
        }
    }

    /// One harmless difference from the JS, written down because it looks like a
    /// bug the first time you diff the two URLs: Foundation's `JSONEncoder`
    /// escapes `/` inside a string as `\/`, so an input of `a/b` goes out as
    /// `%22a%5C%2Fb%22` where `JSON.stringify` would send `%22a%2Fb%22`.
    /// `\/` is a legal JSON escape and `JSON.parse` gives back the same string,
    /// so the server sees no difference. Only the bytes differ, and nothing
    /// signs or caches these URLs.
    private static func envelope<In: Encodable>(_ input: In?) throws -> Data {
        let e = JSONEncoder()
        // Only reached if a future input type holds a Date. It would need
        // superjson `meta` to arrive as a Date server-side; ISO-8601 at least
        // matches what a `z.string().datetime()` input would accept, instead of
        // Foundation's default (seconds since 2001, which nothing understands).
        e.dateEncodingStrategy = .iso8601
        return try e.encode(Envelope(input: input))
    }

    /// `encodeURIComponent`: unreserved plus `-_.!~*'()`, everything else
    /// percent-escaped over UTF-8. Same output as the JS the gateway uses, down
    /// to how a Chinese character is escaped.
    static func percentEncoded(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    /// Scheme + host + port, nothing else. Also collapses a trailing slash, so
    /// `https://host/` and `https://host` cannot produce two different URLs.
    static func rootOf(_ origin: URL) -> String {
        guard var c = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            return origin.absoluteString
        }
        c.path = ""
        c.query = nil
        c.fragment = nil
        c.user = nil
        c.password = nil
        var s = c.string ?? origin.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    // MARK: - Response shapes

    private struct Batch<Out: Decodable>: Decodable {
        struct Success: Decodable {
            struct Payload: Decodable {
                let json: Out
                // `meta` is deliberately not declared — see the type comment.
            }
            let data: Payload
        }
        let result: Success?
    }

    /// `[{"error":{"json":{"message":…,"data":{"code":"UNAUTHORIZED","httpStatus":401}}}}]`.
    /// Parsed leniently and separately from the success path so that a failure
    /// never depends on `Out` being decodable.
    private struct ErrorBatch: Decodable {
        struct Wrapper: Decodable {
            struct Body: Decodable {
                struct Info: Decodable {
                    let code: String?
                    let httpStatus: Int?
                }
                let message: String?
                let data: Info?
            }
            let json: Body?
        }
        let error: Wrapper?
    }

    private static func rpcError(in data: Data, status: Int) -> HermitAPIError? {
        guard let batch = try? decoder.decode([ErrorBatch].self, from: data),
              let body = batch.compactMap({ $0.error?.json }).first else { return nil }
        return .rpc(
            code: body.data?.code ?? "UNKNOWN",
            message: body.message ?? "the dashboard refused the call",
            httpStatus: body.data?.httpStatus ?? status
        )
    }

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            guard let date = isoDate(s) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "not an ISO-8601 date: \(s)")
                )
            }
            return date
        }
        return d
    }()

    /// superjson emits `toISOString()`, which always has milliseconds — but a
    /// hand-rolled `/api/sync/*` payload or a future column read straight out of
    /// Postgres may not, and one missing `.000` should not fail a whole screen.
    private static func isoDate(_ s: String) -> Date? {
        for f in [isoWithMillis, isoPlain] {
            if let d = f.date(from: s) { return d }
        }
        return nil
    }

    private static let isoWithMillis: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Enough of a non-tRPC body to recognise it in a log, and not so much that
    /// an HTML error page floods the console.
    private static func preview(_ data: Data) -> String {
        let s = String(data: data.prefix(400), encoding: .utf8) ?? "<\(data.count) bytes>"
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Everything that can go wrong above the transport. `URLError` is NOT folded in
/// here: offline, timeout and cancellation are its own well-known codes and the
/// caller needs to tell them apart.
enum HermitAPIError: LocalizedError, Equatable {
    /// The origin plus the procedure name did not make a URL. A programming
    /// error, not a runtime condition.
    case badURL(String)
    /// A non-2xx whose body is not a tRPC error — a proxy, not the dashboard.
    case http(status: Int, body: String)
    /// The dashboard answered, and said no.
    case rpc(code: String, message: String, httpStatus: Int)
    /// The dashboard answered with something this cannot read.
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case .badURL(let u): return "bad request URL: \(u)"
        case .http(let status, let body): return "HTTP \(status): \(body)"
        case .rpc(let code, let message, _): return "\(code): \(message)"
        case .malformed(let what): return "unreadable response — \(what)"
        }
    }

    /// The key was missing, wrong, or scoped away from this procedure. Worth
    /// telling apart because it is the one failure retrying cannot fix.
    var isUnauthorized: Bool {
        switch self {
        case .rpc(let code, _, let httpStatus): return code == "UNAUTHORIZED" || code == "FORBIDDEN" || httpStatus == 401 || httpStatus == 403
        case .http(let status, _): return status == 401 || status == 403
        default: return false
        }
    }

    /// Is sending this again a reasonable thing to do? The outbound queue asks;
    /// a 4xx means the request itself is wrong and will be wrong forever, so
    /// re-sending it only burns battery. 408 and 429 are the two 4xx that are
    /// about timing rather than about the request.
    var isRetriable: Bool {
        switch self {
        case .badURL, .malformed: return false
        case .http(let status, _): return Self.retriable(status)
        case .rpc(_, _, let httpStatus): return Self.retriable(httpStatus)
        }
    }

    private static func retriable(_ status: Int) -> Bool {
        status == 408 || status == 429 || status >= 500 || status == 0
    }
}
