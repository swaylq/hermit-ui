// Drives HermitAPI against tools/api-fixture/server.py and prints what came
// back. Not a test target — `swiftc -typecheck Hermit/*.swift` cannot see this
// file, so it is run, not compiled by accident. Read the output; there are no
// assertions on purpose (the point is to LOOK at the URL that went out).
//
//     apps/ios/tools/api-fixture.sh
import Foundation

// The four shapes M2 段二 needs, declared here rather than in the app: the app
// has no call site for them yet, and inventing one before the credential
// decision (docs/ios-native-progress.md, 下一项) would prejudge it.
struct MachineMe: Decodable {
    let id: String
    let name: String
    let alias: String?
    let hostname: String?
    let keyPrefix: String
    let createdAt: Date
    let lastSeen: Date?
    let fiveHourLimitUsd: Double?
    let weeklyLimitUsd: Double?
}
struct SessionRow: Decodable { let id: String; let title: String }
struct SessionList: Decodable { let sessions: [SessionRow] }
struct Ok: Decodable { let ok: Bool }
struct ListInput: Encodable { let agentName: String }
struct RegisterInput: Encodable { let token: String; let apnsEnv: String; let platform: String }

let port = CommandLine.arguments[1]
// The origin deliberately carries a path, a query and a fragment: `-hermitOrigin`
// is allowed to (AppConfig.launchArgumentOrigin), and none of it may end up in
// front of /api/trpc.
let api = HermitAPI(origin: URL(string: "http://127.0.0.1:\(port)/push?x=1#frag")!, key: { "K-FIXTURE" })

func say(_ s: String) { print(s); fflush(stdout) }
let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

say("root                 \(api.root)")
say("root (user:pass@, /) \(HermitAPI.rootOf(URL(string: "https://u:p@dash.swaylab.ai:8443/")!))")
// Must equal encodeURIComponent of the same string, byte for byte:
//   node -e 'process.stdout.write(encodeURIComponent(`a b=c&d?e#f/g+h%i`))'
say("encodeURIComponent   \(HermitAPI.percentEncoded("a b=c&d?e#f/g+h%i"))")

let done = DispatchSemaphore(value: 0)
Task<Void, Never> {
    do {
        let me = try await api.query("machines.me", as: MachineMe.self)
        let alias: String = me.alias ?? "nil"
        let created: String = iso.string(from: me.createdAt)
        let seen: String = me.lastSeen == nil ? "nil" : iso.string(from: me.lastSeen!)
        let limit: String = me.weeklyLimitUsd == nil ? "nil" : "\(me.weeklyLimitUsd!)"
        say("machines.me          \(me.name) alias=\(alias) createdAt=\(created) lastSeen=\(seen) weeklyLimitUsd=\(limit)")
    } catch { say("machines.me          FAILED \(error)") }

    do {
        // Every character that would break a naive query-string encoder.
        let l = try await api.query("chat.listSessions", input: ListInput(agentName: "a&b+c/d 你好"), as: SessionList.self)
        say("chat.listSessions    \(l.sessions.map(\.title).joined(separator: " | "))")
    } catch { say("chat.listSessions    FAILED \(error)") }

    do {
        let r = try await api.mutate("push.register", input: RegisterInput(token: "TOK", apnsEnv: "sandbox", platform: "ios"), as: Ok.self)
        say("push.register        ok=\(r.ok)")
    } catch { say("push.register        FAILED \(error)") }

    for proc in ["boom.unauth", "boom.proxy", "boom.garbage"] {
        do {
            _ = try await api.query(proc, as: Ok.self)
            say("\(proc.padding(toLength: 20, withPad: " ", startingAt: 0)) DID NOT THROW — wrong")
        } catch let e as HermitAPIError {
            let name: String = proc.padding(toLength: 20, withPad: " ", startingAt: 0)
            let why: String = String(e.localizedDescription.prefix(58))
            say("\(name) \(why)  [401/403=\(e.isUnauthorized) retriable=\(e.isRetriable)]")
        } catch { say("\(proc) threw the wrong type: \(error)") }
    }

    do {
        _ = try await api.query("boom.baddate", as: MachineMe.self)
        say("boom.baddate         DID NOT THROW — wrong")
    } catch let e as HermitAPIError {
        say("boom.baddate         \(String(e.localizedDescription.prefix(58)))")
    } catch { say("boom.baddate threw the wrong type: \(error)") }

    // The real listSessions shape, decoded into the type the native list draws
    // — and then judged by the port of sessionStatusView, so the whole path
    // from "the server's JSON" to "which dot" runs once outside a simulator.
    // The row carries eleven fields SessionListItem does not declare; if
    // Decodable ever stopped ignoring them this is where it would surface.
    do {
        let rows = try await api.query("chat.recents", as: [SessionListItem].self)
        for r in rows {
            let v = SessionStatus.view(r.statusRow, StatusOptions(unread: r.unread))
            say("chat.recents         \(r.id) title=\(r.displayTitle) "
                + "recency=\(iso.string(from: r.recencyAt)) unread=\(r.unread) "
                + "dot=\(v.dot) label=\(v.label)")
        }
    } catch { say("chat.recents         FAILED \(error)") }

    // Nothing is listening here. A URLError must come out, NOT a HermitAPIError:
    // the outbound queue has to tell "offline" from "the server said no".
    let dead = HermitAPI(origin: URL(string: "http://127.0.0.1:1")!, key: { "K" })
    do {
        _ = try await dead.query("machines.me", as: Ok.self)
        say("offline              DID NOT THROW — wrong")
    } catch let e as URLError {
        say("offline              URLError(\(e.code.rawValue)) \(e.localizedDescription)")
    } catch { say("offline threw the wrong type: \(error)") }

    done.signal()
}
done.wait()
