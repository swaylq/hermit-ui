import XCTest

/// The shell's end-to-end check: does the app come up, sign in, and render the
/// dashboard on a real (simulated) phone — and do the screens that changed for
/// iOS actually look right?
///
/// This exists because for a year the answer was "the Swift type-checks": the
/// project had never produced a `.app`, let alone run one. Everything else about
/// the shell is a thin wrapper around a web page, so one real launch is worth more
/// than any number of unit tests around the seams.
///
/// Inputs, all from the environment so nothing lands in argv or the repo
/// (`xcodebuild` forwards `TEST_RUNNER_FOO` to the test process as `FOO`):
///   HERMIT_TEST_KEY  machine access key. Absent → stops at the sign-in screen.
///   HERMIT_ORIGIN    dashboard to point at. Absent → the shipping URL.
///   HERMIT_SHOT_DIR  where to drop PNGs on the host filesystem.
final class SmokeTests: XCTestCase {
    private var app: XCUIApplication!

    private var origin: String { ProcessInfo.processInfo.environment["HERMIT_ORIGIN"] ?? "" }
    private var key: String { ProcessInfo.processInfo.environment["HERMIT_TEST_KEY"] ?? "" }

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    func testDashboardLoads() throws {
        launch(path: "")

        // Criterion 2, and it is checked BEFORE anything is allowed to dismiss an
        // alert: at a cold launch with an empty keyring there must be no system
        // notification prompt. There is nothing to register a token against yet,
        // so a "no" here would be permanent and wasted. (Dismissing first and
        // asserting after is how this assertion silently stops testing anything.)
        let field = signInField(timeout: 45)
        if field.exists {
            // Dwell rather than sample: an early prompt can arrive a beat after the
            // page paints, and `.exists` only sees the instant it is called.
            for _ in 0..<8 {
                XCTAssertFalse(
                    springboard.alerts.firstMatch.exists,
                    "a system alert is up on the sign-in screen — the shell asked for something before there was a key")
                Thread.sleep(forTimeInterval: 0.5)
            }
            shoot("01-signin")
            answerSystemAlerts()

            guard !key.isEmpty else { throw XCTSkip("no HERMIT_TEST_KEY — stopped at sign-in") }
            field.tap()
            field.typeText(key)
            // By label, not `firstMatch`: the gate has two inputs and a button and
            // accessibility-tree order is not a contract.
            let submit = app.webViews.buttons["sign in"]
            XCTAssertTrue(submit.waitForExistence(timeout: 10), "no sign-in button on the gate")
            submit.tap()
            XCTAssertTrue(field.waitForNonExistence(timeout: 60), "still on the sign-in screen after submitting")
        }

        XCTAssertTrue(webContentAppears(), "the dashboard rendered no text")
        assertSignedIn("after sign-in")
        // The permission prompt is expected HERE — after sign-in, once the web
        // layer has a key to register the token against.
        Thread.sleep(forTimeInterval: 3)
        shoot("02-signed-in-prompt")
        answerSystemAlerts()
        Thread.sleep(forTimeInterval: 4)
        shoot("03-chat")

        // The phone's overflow tray. It floats LEFT of the persistent buttons, so
        // it used to run off the screen edge as soon as the persistent cluster
        // grew — taking the cancel ✕ of any armed confirm with it.
        let more = app.webViews.buttons["more actions"]
        if more.waitForExistence(timeout: 10) {
            more.tap()
            Thread.sleep(forTimeInterval: 2)
            shoot("03a-mobile-tray")
            // Left open on purpose: the toggle's accessibility label flips to
            // "hide more actions" once it is, so tapping `more` again matches
            // nothing. The tray lives in the header and the next step is at the
            // bottom of the screen, so it is not in the way.
        }

        // The composer with the keyboard up: `--app-h` has to shrink the shell to
        // the visible viewport, or the input sits behind the keyboard. Only
        // meaningful when the simulator is showing a software keyboard.
        if let composer = firstEditable(), composer.waitForExistence(timeout: 10) {
            composer.tap()
            Thread.sleep(forTimeInterval: 3)
            shoot("03b-composer-keyboard")
        }

        // Settings → Push: inside the shell this must show the native APNs card,
        // not "add this to your Home Screen" (there is no Safari share sheet in an
        // app, and APNs already works).
        shootPage("/push", named: "04-push")
        // A settings list whose last row used to sit in the home-indicator strip.
        shootPage("/trash", named: "05-trash")
        // The sheet/​lightbox portal target and the sidebar drawer, i.e. the two
        // places the missing safe-area insets showed up first.
        shootPage("/watchdogs", named: "06-watchdogs")
    }

    /// The screen that fixes a wrong address, driven end to end.
    ///
    /// It needs no key and no network, because it is only reachable when the
    /// address answers nothing: `-hermitOriginOverride` is read straight out of
    /// UserDefaults' argument domain, so this launch behaves exactly like one
    /// where the user had typed that address — without writing it to disk, which
    /// would follow the install into the next test.
    ///
    /// What it is checking is the wiring, not the parsing: `normalizeOrigin` has
    /// its own unit tests, and what those cannot see is whether a person can
    /// actually reach it, read the refusal, and get their typing back.
    func testServerAddressCanBeChanged() {
        // A high closed port, NOT one of the low ones. WebKit refuses to load
        // anything from its blocked-port list (9, 25, 587, …) and the refusal is
        // not a navigation failure — it commits an empty document, so the offline
        // screen never appears and the app just sits there white.
        let dead = "http://127.0.0.1:49517"
        app.launchArguments = ["-hermitOriginOverride", dead]
        app.launch()

        let change = app.buttons["Change server"]
        XCTAssertTrue(change.waitForExistence(timeout: 30), "no offline screen for an address nothing answers on")
        XCTAssertTrue(app.buttons["Retry"].exists, "the offline screen lost its Retry button")
        XCTAssertTrue(app.staticTexts[dead].exists, "the offline screen does not say WHICH server it tried")
        shoot("07-offline")

        change.tap()
        let dialog = app.alerts["Server address"]
        XCTAssertTrue(dialog.waitForExistence(timeout: 5), "Change server opened nothing")
        let field = dialog.textFields.firstMatch
        XCTAssertEqual(field.value as? String, dead, "the address box did not start from the current address")
        XCTAssertTrue(dialog.buttons["Use default"].exists, "no way back to the shipped address")
        shoot("08-server-address")

        // A path on the end: the typo `normalizeOrigin` exists to catch, and the
        // one that would otherwise put a machine key on the wire to a stranger.
        let typo = "https://example.com/path"
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: dead.count))
        field.typeText(typo)
        dialog.buttons["Connect"].tap()

        let refusal = app.alerts["Can't use that address"]
        XCTAssertTrue(refusal.waitForExistence(timeout: 5), "a bad address was accepted")
        XCTAssertTrue(
            refusal.staticTexts["backend address must be a bare origin, no path"].exists,
            "the refusal is not the web layer's own wording")
        shoot("09-address-refused")

        refusal.buttons["OK"].tap()
        let second = app.alerts["Server address"]
        XCTAssertTrue(second.waitForExistence(timeout: 5), "the refusal was a dead end")
        XCTAssertEqual(
            second.textFields.firstMatch.value as? String, typo,
            "the address had to be retyped from scratch to fix one character")
        shoot("10-address-kept")
        second.buttons["Cancel"].tap()
        XCTAssertTrue(change.waitForExistence(timeout: 5), "Cancel did not put the offline screen back")
    }

    /// The page asking the shell to point somewhere else — `nativeRequest`'s
    /// first real method, driven end to end from a real document.
    ///
    /// Needs `HERMIT_BRIDGE_ORIGIN`, a static server holding
    /// tools/bridge-fixture; `tools/bridge-fixture.sh` starts one and runs just
    /// this test. No key and no dashboard: the fixture speaks the wire protocol
    /// itself.
    ///
    /// Two launches, because one cannot show this. `-hermitOrigin` is read from
    /// UserDefaults' ARGUMENT domain, which outranks the value `setOrigin`
    /// writes — so while the fixture is on screen the shell cannot actually move.
    /// The second launch drops the argument, and what appears is whatever the
    /// first one persisted.
    func testThePageCanProposeAnotherServer() throws {
        let fixture = ProcessInfo.processInfo.environment["HERMIT_BRIDGE_ORIGIN"] ?? ""
        guard !fixture.isEmpty else { throw XCTSkip("no HERMIT_BRIDGE_ORIGIN — see tools/bridge-fixture.sh") }
        // Must match DEAD in tools/bridge-fixture/index.html.
        let dead = "http://127.0.0.1:49517"

        app.launchArguments = ["-hermitOrigin", fixture]
        app.launch()
        XCTAssertTrue(
            app.webViews.buttons["getOrigin"].waitForExistence(timeout: 30),
            "the fixture page never loaded — is the static server still up?")
        shoot("11-bridge-fixture")

        // A method the shell has never heard of fails immediately rather than
        // hanging: a page always ships ahead of the app store.
        app.webViews.buttons["nosuchmethod"].tap()
        XCTAssertTrue(fixtureSays("unknown method: nosuchmethod"), "an unknown method did not come back as one")

        // Read-only, and the answer has to be the shell's view rather than the
        // page's own `location.origin`.
        app.webViews.buttons["getOrigin"].tap()
        XCTAssertTrue(fixtureSays(fixture), "getOrigin did not report where the shell points")

        // A bad address is refused with no dialog at all — and in the web
        // layer's own wording, not a second opinion.
        app.webViews.buttons["setOrigin — address with a path"].tap()
        XCTAssertTrue(
            fixtureSays("backend address must be a bare origin, no path"),
            "a path on the end was either accepted or refused in different words")
        XCTAssertFalse(app.alerts["Switch server?"].exists, "a malformed address should never reach a dialog")

        // A good one does NOT apply itself. The microphone is granted on an
        // exact host match against wherever the shell points, so a page that
        // could move it silently would be a permanent silent microphone.
        app.webViews.buttons["setOrigin — dead address"].tap()
        let confirm = app.alerts["Switch server?"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "the page moved the shell without asking anyone")
        XCTAssertTrue(
            confirm.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", dead)).firstMatch.exists,
            "the confirmation does not say which address it would move to")
        shoot("12-switch-confirm")

        confirm.buttons["Cancel"].tap()
        XCTAssertTrue(fixtureSays("cancelled"), "Cancel left the page waiting instead of answering it")
        XCTAssertTrue(app.webViews.buttons["getOrigin"].exists, "Cancel navigated away anyway")

        app.webViews.buttons["setOrigin — dead address"].tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "the confirmation did not come back a second time")
        confirm.buttons["Switch"].tap()

        // Second launch, no launch argument: only what was persisted decides.
        app.terminate()
        app.launchArguments = []
        app.launch()
        let change = app.buttons["Change server"]
        XCTAssertTrue(
            change.waitForExistence(timeout: 30),
            "after confirming, a relaunch did not come up against the new address")
        XCTAssertTrue(app.staticTexts[dead].exists, "the shell relaunched against some other address")
        shoot("13-switched")

        // Put it back, or this install stays pointed at a dead port for whatever
        // runs next. `clearOrigin` removes the key rather than overwriting it.
        change.tap()
        let editor = app.alerts["Server address"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "no way to undo the switch")
        editor.buttons["Use default"].tap()
        XCTAssertTrue(editor.waitForNonExistence(timeout: 10), "the address dialog stayed up")
    }

    // MARK: - helpers

    /// Wait for the fixture's result line to mention something. Substring rather
    /// than equality: the line carries the method and the shell's own sentence,
    /// and the assertion is about the sentence.
    private func fixtureSays(_ needle: String, timeout: TimeInterval = 8) -> Bool {
        let match = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", needle))
        return match.firstMatch.waitForExistence(timeout: timeout)
    }

    private var springboard: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    /// The chat composer, as WebKit exposes it. A textarea surfaces as a text
    /// view on some builds and a text field on others, so try both.
    private func firstEditable() -> XCUIElement? {
        let views = app.webViews.textViews
        if views.count > 0 { return views.element(boundBy: views.count - 1) }
        let fields = app.webViews.textFields
        if fields.count > 0 { return fields.element(boundBy: fields.count - 1) }
        return nil
    }

    /// Point the shell somewhere. `-hermitOrigin` lands in UserDefaults' argument
    /// domain, which is what AppConfig reads.
    private func launch(path: String) {
        app.launchArguments = origin.isEmpty ? [] : ["-hermitOrigin", origin + path]
        app.launch()
    }

    /// The key box. It is `type="password"`, so it surfaces as a SECURE text
    /// field — waiting on `textFields` instead silently skipped the whole sign-in
    /// and left the run screenshotting the gate.
    private func signInField(timeout: TimeInterval) -> XCUIElement {
        let secure = app.webViews.secureTextFields.firstMatch
        if secure.waitForExistence(timeout: timeout) { return secure }
        return app.webViews.textFields.firstMatch
    }

    /// Nothing downstream is worth looking at while the gate is still up.
    private func assertSignedIn(_ context: String) {
        guard !key.isEmpty else { return }
        XCTAssertFalse(
            app.webViews.buttons["sign in"].exists,
            "\(context): still on the sign-in gate")
    }

    @discardableResult
    private func webContentAppears() -> Bool {
        guard app.webViews.firstMatch.waitForExistence(timeout: 30) else { return false }
        return app.webViews.staticTexts.firstMatch.waitForExistence(timeout: 45)
    }

    /// Relaunch straight onto a route and shoot it. Cheaper and far less brittle
    /// than tapping through a web sidebar, and the keyring survives in the shared
    /// data store so no re-sign-in is needed.
    private func shootPage(_ path: String, named name: String) {
        guard !origin.isEmpty else { return }
        app.terminate()
        launch(path: path)
        XCTAssertTrue(webContentAppears(), "\(path) rendered no text")
        assertSignedIn(path)
        Thread.sleep(forTimeInterval: 4)
        answerSystemAlerts()
        shoot(name)
    }

    /// XCUITest's interruption monitors only fire on the NEXT interaction, which is
    /// too late when the alert is the first thing on screen. Tapping SpringBoard's
    /// alert directly is the deterministic version.
    private func answerSystemAlerts() {
        for _ in 0..<3 {
            let alert = springboard.alerts.firstMatch
            guard alert.waitForExistence(timeout: 3) else { return }
            let allow = alert.buttons["允许"].exists ? alert.buttons["允许"] : alert.buttons["Allow"]
            if allow.exists { allow.tap() }
            else if alert.buttons.count > 0 { alert.buttons.element(boundBy: alert.buttons.count - 1).tap() }
            else { return }
        }
    }

    /// Attach to the result bundle AND, when the harness says where, drop a PNG on
    /// the host filesystem — simulator processes run natively on the Mac, so a
    /// plain file write lands somewhere a human can look at without xcresulttool.
    private func shoot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        guard let dir = ProcessInfo.processInfo.environment["HERMIT_SHOT_DIR"], !dir.isEmpty else { return }
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: dir), withIntermediateDirectories: true)
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
}
