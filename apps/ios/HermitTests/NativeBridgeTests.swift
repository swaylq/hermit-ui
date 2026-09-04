import WebKit
import XCTest
@testable import Hermit

/// The bridge's question channel, driven by a real WKWebView.
///
/// Worth a real web view rather than a fake: the thing that can be wrong here is
/// the PAIRING — an answer reaching the wrong question — and pairing only fails
/// under concurrency, out-of-order answers and ids that have already been
/// retired. A hand-rolled double would pair them the way I expect and prove
/// nothing. So the page below is a real document posting real script messages,
/// and the assertions are the ones docs/ios-native-design.md asks for: a hundred
/// questions in flight at once all get their own answer, and the one nobody
/// answers takes the timeout branch.
final class NativeBridgeTests: XCTestCase {
    private var webView: WKWebView!
    private var bridge: NativeBridge!

    /// A stand-in for lib/native-bridge.ts: records every reply by id, and
    /// answers the shell's own questions.
    private static let page = """
    <html><body><script>
      window.__replies = {};
      window.__counts = {};
      window.__hermitNative = {
        onReply: function (id, ok, payload) {
          window.__replies[id] = { ok: ok, payload: payload };
          window.__counts[id] = (window.__counts[id] || 0) + 1;
        },
        onRequest: function (id, method, params) {
          if (method === 'echo') {
            post({ type: 'reply', id: id, ok: true, payload: { got: params.value } });
          } else if (method === 'refuse') {
            post({ type: 'reply', id: id, ok: false, payload: { error: 'nope' } });
          } else if (method === 'twice') {
            post({ type: 'reply', id: id, ok: true, payload: 'first' });
            post({ type: 'reply', id: id, ok: true, payload: 'second' });
          }
          // Anything else is deliberately left unanswered: that is the timeout
          // case, and it has to be a real silence rather than a slow reply.
        }
      };
      function post(m) { window.webkit.messageHandlers.hermit.postMessage(m); }
      window.ask = function (n) {
        for (var i = 0; i < n; i++) post({ type: 'req', id: 'q' + i, method: 'double', params: { n: i } });
      };
      window.askOnce = function (id, method) { post({ type: 'req', id: id, method: method, params: {} }); };
      post({ type: 'ready' });
    </script></body></html>
    """

    override func setUp() {
        super.setUp()
        let config = WKWebViewConfiguration()
        bridge = NativeBridge()
        config.userContentController.add(bridge, name: NativeBridge.handlerName)
        webView = WKWebView(frame: .zero, configuration: config)
        bridge.attach(to: webView)
        webView.loadHTMLString(Self.page, baseURL: nil)
        // `ready` rides the same web-process → UI-process queue as this probe, so
        // once the probe answers, the message the page posted before it has
        // already been handled.
        XCTAssertTrue(spin { self.js("window.__hermitNative ? 1 : 0") == "1" }, "test page never loaded")
    }

    override func tearDown() {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: NativeBridge.handlerName)
        webView = nil
        bridge = nil
        super.tearDown()
    }

    // MARK: - driving the page

    /// Run the main run loop until `done` or the deadline. Polling rather than an
    /// expectation because WebKit's callbacks need this thread free, and every
    /// wait here is for something the web process does on its own schedule.
    private func spin(timeout: TimeInterval = 10, _ done: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() {
            if Date() >= deadline { return done() }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        return true
    }

    /// Evaluate and return the result as a string. Synchronous by design — the
    /// tests read it inside `spin`.
    @discardableResult
    private func js(_ script: String) -> String? {
        var out: String?
        var finished = false
        webView.evaluateJavaScript(script) { value, _ in
            if let v = value, !(v is NSNull) { out = String(describing: v) }
            finished = true
        }
        _ = spin(timeout: 5) { finished }
        return out
    }

    private func replies() -> [String: [String: Any]] {
        guard let json = js("JSON.stringify(window.__replies)"),
              let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]]
        else { return [:] }
        return obj
    }

    // MARK: - web → native

    /// The one that matters: a hundred questions in flight at once, answered out
    /// of order and off the main thread, each landing on its own id.
    func testAHundredConcurrentQuestionsEachGetTheirOwnAnswer() {
        bridge.onRequest = { method, params, reply in
            guard method == "double", let n = params["n"] as? Int else {
                reply(false, ["error": "unknown method: \(method)"])
                return
            }
            // Off the main queue and jittered: a bridge that pairs by arrival
            // order instead of by id passes only when the answers come back in
            // the order they were asked.
            DispatchQueue.global().asyncAfter(deadline: .now() + Double.random(in: 0...0.05)) {
                reply(true, ["n": n * 2])
            }
        }

        js("window.ask(100)")
        XCTAssertTrue(spin { self.js("Object.keys(window.__replies).length") == "100" },
                      "only \(self.replies().count) of 100 answers came back")

        let got = replies()
        for i in 0..<100 {
            guard let entry = got["q\(i)"] else { return XCTFail("no answer for q\(i)") }
            XCTAssertEqual(entry["ok"] as? Bool, true, "q\(i) was refused")
            XCTAssertEqual((entry["payload"] as? [String: Any])?["n"] as? Int, i * 2,
                           "q\(i) got another question's answer")
        }
    }

    /// A handler that answers twice — a retry racing its own completion — must
    /// not put two replies on one id. The page has already freed it, so the
    /// second would be delivered to whichever question took that id next.
    func testAnAnswerSentTwiceIsDeliveredOnce() {
        bridge.onRequest = { _, _, reply in
            reply(true, "first")
            reply(true, "second")
        }
        js("window.askOnce('dup', 'anything')")
        XCTAssertTrue(spin { self.replies()["dup"] != nil }, "no answer at all")
        // A second delivery would arrive after the first; give it the chance to.
        _ = spin(timeout: 0.5) { false }
        XCTAssertEqual(js("window.__counts.dup"), "1")
        XCTAssertEqual(replies()["dup"]?["payload"] as? String, "first")
    }

    /// A build with no handler at all still has to answer, or the page pays the
    /// full timeout for a method this shell was never going to know.
    func testAQuestionNoBuildCanAnswerIsRefusedImmediately() {
        bridge.onRequest = nil
        js("window.askOnce('old', 'keychain.get')")
        XCTAssertTrue(spin(timeout: 2) { self.replies()["old"] != nil }, "no answer, so the page would hang")
        let entry = replies()["old"]
        XCTAssertEqual(entry?["ok"] as? Bool, false)
        XCTAssertEqual((entry?["payload"] as? [String: Any])?["error"] as? String,
                       "unknown method: keychain.get")
    }

    // MARK: - native → web

    func testThePageCanBeAskedSomething() {
        var answer: (ok: Bool, payload: Any?)?
        bridge.request("echo", params: ["value": "hi"]) { ok, payload in answer = (ok, payload) }
        XCTAssertTrue(spin { answer != nil }, "the page never answered")
        XCTAssertEqual(answer?.ok, true)
        XCTAssertEqual((answer?.payload as? [String: Any])?["got"] as? String, "hi")
    }

    func testAPageThatRefusesIsNotMistakenForOneThatFailed() {
        var answer: (ok: Bool, payload: Any?)?
        bridge.request("refuse") { ok, payload in answer = (ok, payload) }
        XCTAssertTrue(spin { answer != nil })
        XCTAssertEqual(answer?.ok, false)
        XCTAssertEqual((answer?.payload as? [String: Any])?["error"] as? String, "nope")
    }

    /// The timeout branch. Five seconds of real silence, because the failure this
    /// guards against — a completion block that never runs — cannot be
    /// distinguished from a slow answer any other way.
    func testAQuestionThePageIgnoresTimesOutRatherThanHanging() {
        var calls = 0
        var answer: (ok: Bool, payload: Any?)?
        let started = Date()
        bridge.request("silent") { ok, payload in
            calls += 1
            answer = (ok, payload)
        }
        XCTAssertTrue(spin(timeout: NativeBridge.replyTimeout + 3) { answer != nil },
                      "the completion never ran — this is the hang it exists to prevent")
        XCTAssertEqual(answer?.ok, false)
        XCTAssertNil(answer?.payload)
        XCTAssertEqual(calls, 1)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), NativeBridge.replyTimeout - 0.5)
    }

    /// A late answer to a question that already timed out is dropped, not handed
    /// to whoever asked next.
    func testALateAnswerIsNotDeliveredTwice() {
        var calls = 0
        bridge.request("twice") { _, _ in calls += 1 }
        XCTAssertTrue(spin { calls > 0 })
        _ = spin(timeout: 0.5) { false }
        XCTAssertEqual(calls, 1)
    }

    /// Navigating away kills every question in flight. Without this the caller
    /// waits out the full timeout for a document that no longer exists — and a
    /// reload is exactly when the shell asks things.
    func testReloadingFailsEveryQuestionInFlightAtOnce() {
        var answer: (ok: Bool, payload: Any?)?
        bridge.request("silent") { ok, payload in answer = (ok, payload) }
        XCTAssertNil(answer, "a question with no answer yet should still be waiting")
        bridge.pageWillReload()
        XCTAssertNotNil(answer, "the completion should have run the moment the page went away")
        XCTAssertEqual(answer?.ok, false)
    }

    /// Before the page says `ready` there is no `window.__hermitNative` to call,
    /// so the question would vanish into the `&&` and take the timeout. Fail it
    /// now instead.
    func testAskingBeforeThePageIsReadyFailsImmediately() {
        bridge.pageWillReload()
        var answer: (ok: Bool, payload: Any?)?
        bridge.request("echo") { ok, payload in answer = (ok, payload) }
        XCTAssertEqual(answer?.ok, false, "should have failed synchronously, not waited")
    }
}
