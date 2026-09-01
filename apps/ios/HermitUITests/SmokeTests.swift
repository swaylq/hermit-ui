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

    // MARK: - helpers

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
