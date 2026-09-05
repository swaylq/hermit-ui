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
        openPage()
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

    /// The keyring's new home, driven from a real document.
    ///
    /// Same fixture and same two-launch shape as the test above, for a different
    /// reason: what has to be shown here is that the value OUTLIVES the process,
    /// which is the entire point of moving it out of the web view's localStorage.
    /// (localStorage would have survived too — the Keychain is about the file on
    /// disk being encrypted, which no UI test can see. What this pins down is that
    /// the round trip works and nothing reshapes the bytes on the way.)
    func testTheKeychainKeepsTheKeyring() throws {
        let fixture = ProcessInfo.processInfo.environment["HERMIT_BRIDGE_ORIGIN"] ?? ""
        guard !fixture.isEmpty else { throw XCTSkip("no HERMIT_BRIDGE_ORIGIN — see tools/bridge-fixture.sh") }
        // Must match SECRET in tools/bridge-fixture/index.html.
        let secret = "keyring-marker-42"

        app.launchArguments = ["-hermitOrigin", fixture]
        app.launch()
        // Whatever the test before this one left in the keyring decides which of
        // the two screens comes up first, so ask for the page rather than assume it.
        openPage()

        // Start from nothing, whatever ran before. `{"value":null}` and not an
        // error: "there is no entry" is an answer the dashboard acts on — it is
        // the signal to migrate its localStorage copy in.
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(
            fixtureSays("keychain.clear ok"),
            "keychain.clear did not answer — a `-34018` in the result line means this "
                + "build is unsigned; see CODE_SIGN_IDENTITY in tools/bridge-fixture.sh")
        app.webViews.buttons["keychain.get"].tap()
        XCTAssertTrue(fixtureSays("{\"value\":null}"), "an empty keychain did not read back as empty")

        app.webViews.buttons["keychain.set"].tap()
        XCTAssertTrue(fixtureSays("keychain.set ok"), "the shell refused to store anything")
        app.webViews.buttons["keychain.get"].tap()
        XCTAssertTrue(fixtureSays(secret), "what came back is not what went in")
        shoot("14-keychain-roundtrip")

        // A cold start is the one that matters: on the real thing this is the
        // difference between opening the app and being asked to sign in again.
        app.terminate()
        app.launch()
        // Through the list: a stored keyring means the front door is the session
        // list, not the page. That is the whole point of the change, and the
        // page is one tap behind it.
        openPage()
        app.webViews.buttons["keychain.get"].tap()
        XCTAssertTrue(fixtureSays(secret), "the keychain lost the value across a relaunch")
        shoot("15-keychain-after-relaunch")

        // Signing out has to actually remove it, and leave this install clean for
        // whatever test runs next.
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer the second time")
        app.webViews.buttons["keychain.get"].tap()
        XCTAssertTrue(fixtureSays("{\"value\":null}"), "signing out left the keyring in the keychain")
    }

    /// The native session list, on a real phone, against a server that answers
    /// per key.
    ///
    /// The screen already compiles and renders on the Mac — `tools/render-list.sh`
    /// draws it in five seconds without a simulator. What only a device can show
    /// is the half that is not layout: the shell opening the Keychain by itself,
    /// choosing between two stored entries, and putting that entry's token on a
    /// request it makes with nobody's help.
    ///
    /// So the fixture server answers `chat.listSessions` differently per key, and
    /// the first row is titled with whichever machine the shell reached for. This
    /// is the only assertion here that could not be made on the Mac: a shell that
    /// ignored the active id and sent `list[0]` would draw a full, plausible,
    /// entirely wrong list, and nothing would error.
    ///
    /// Needs `HERMIT_BRIDGE_ORIGIN`; `tools/bridge-fixture.sh` provides it.
    func testTheNativeListDrawsTheActiveMachinesSessions() throws {
        let fixture = ProcessInfo.processInfo.environment["HERMIT_BRIDGE_ORIGIN"] ?? ""
        guard !fixture.isEmpty else { throw XCTSkip("no HERMIT_BRIDGE_ORIGIN — see tools/bridge-fixture.sh") }

        app.launchArguments = ["-hermitOrigin", fixture]
        app.launch()
        openPage()

        // Start from nothing, then a keyring with two machines in it and the
        // SECOND one active. `list[0]` is `m_one`, on purpose.
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer")
        app.webViews.buttons["keychain.set — two machines"].tap()
        XCTAssertTrue(fixtureSays("keyring ok"), "the shell refused to store the keyring")
        app.webViews.buttons["keychain.setActive — m_two"].tap()
        XCTAssertTrue(fixtureSays("active m_two ok"), "the shell would not record which entry is active")

        openSessionList()
        XCTAssertTrue(
            screenSays("active key: m_two"),
            "the list is drawn with the wrong machine's key — or did not load at all")
        // Two things the port gets wrong invisibly. An empty title has to fall
        // through to the preview (JavaScript's falsiness, and the state every
        // brand-new session is in), and a row with background work outstanding
        // has to print the note, which is the only piece of `activity` the
        // sidebar poll carries.
        XCTAssertTrue(screenSays("帮我看看这个构建为什么挂了", timeout: 5),
                      "an empty title drew a blank row instead of falling through to the preview")
        XCTAssertTrue(screenSays("background · 2 tasks", timeout: 5),
                      "the parked row lost the only status words the poll carries")
        shoot("16-session-list")

        // Back to the page, make the OTHER entry active, and come back. The key
        // is read per request rather than captured at construction, so the same
        // screen has to return naming the other machine.
        openPage()
        app.webViews.buttons["keychain.setActive — m_one"].tap()
        XCTAssertTrue(fixtureSays("active m_one ok"), "the shell would not move the active entry")
        openSessionList()
        XCTAssertTrue(
            screenSays("active key: m_one"),
            "switching machines on the page did not change what the native list asks for")
        shoot("17-session-list-other-machine")

        // Signed out. The list has to say why it is empty — every failure here
        // (no key, wrong key, no network) otherwise looks like "no sessions".
        // This also leaves the install clean for whatever runs next.
        openPage()
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer the second time")
        openSessionList()
        XCTAssertTrue(
            screenSays("No machine key on this device yet"),
            "with no keyring at all the list explained nothing")
        shoot("18-session-list-signed-out")
    }

    /// The list keeps itself fresh — and stops the moment it is not on screen.
    ///
    /// Neither half shows up in a screenshot: a list that polls every five
    /// seconds and a list frozen since you opened it draw the same pixels, and a
    /// timer still firing behind the web view is invisible by definition. So the
    /// fixture numbers its answers and the last row prints the number, which
    /// makes both halves assertable — how many times the shell asked, and when
    /// it stopped asking.
    func testTheNativeListRefreshesItselfWhileYouWatch() throws {
        let fixture = ProcessInfo.processInfo.environment["HERMIT_BRIDGE_ORIGIN"] ?? ""
        guard !fixture.isEmpty else { throw XCTSkip("no HERMIT_BRIDGE_ORIGIN — see tools/bridge-fixture.sh") }

        app.launchArguments = ["-hermitOrigin", fixture]
        app.launch()
        openPage()
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer")
        app.webViews.buttons["keychain.set — two machines"].tap()
        XCTAssertTrue(fixtureSays("keyring ok"), "the shell refused to store the keyring")

        openSessionList()
        XCTAssertTrue(screenSays("poll #"), "the list never drew the fixture's counter row")
        guard let first = pollNumber() else { return XCTFail("could not read the counter row") }

        // Nothing is touched from here on. Two more answers on their own is the
        // 5s timer, and only the 5s timer.
        XCTAssertTrue(
            screenSays("poll #\(first + 2)", timeout: 25),
            "the list never refetched by itself — the poll is not running")
        shoot("19-session-list-polling")

        // Off screen it goes quiet. Twelve seconds is two polls' worth; coming
        // back is worth exactly one fetch, so a third says the timer kept firing
        // behind the web view. (Two is allowed: a poll already on the wire when
        // the screen went away still reaches the server, whatever the shell then
        // does with the answer.)
        let before = pollNumber() ?? 0
        openPage()
        Thread.sleep(forTimeInterval: 12)
        openSessionList()
        XCTAssertTrue(screenSays("poll #"), "the counter row did not come back")
        let after = pollNumber() ?? 0
        XCTAssertGreaterThan(after, before, "coming back to the list did not refetch at all")
        XCTAssertLessThanOrEqual(
            after - before, 2,
            "the list kept polling while it was off screen (#\(before) → #\(after) over 12s)")
    }

    /// The app opens on the PAGE — and the list is still one URL away, still
    /// painting from its snapshot before it asks anybody anything.
    ///
    /// The first claim is a revert. For four rounds the native list was the
    /// root, which made the first thing you saw a screen the web app does not
    /// have: the dashboard's `/` redirects to `/chat` and restores
    /// `lastSessionId()`, so it opens IN a conversation with the session list as
    /// a drawer over it. This is the assertion that keeps it that way — the
    /// shape has flipped twice in eight rounds and both times the symptom was
    /// something a person noticed before a test did.
    ///
    /// The second claim needs arranging, and it is why the list did not simply
    /// lose its cache in that revert. Opening the list paints `SessionListCache`
    /// before it asks the server anything, which against a server that answers
    /// is invisible: the rows would arrive either way, just later. So the second
    /// launch uses a keyring whose ENTRY IDS are unchanged and whose TOKENS the
    /// fixture refuses. The snapshot is keyed by entry id, so it is still found;
    /// the 401 behind it cannot be what put the rows on screen. Without a
    /// snapshot that same launch shows the failure sentence and nothing else.
    func testTheWebAppIsTheFrontDoorAndTheListIsBehindIt() throws {
        let fixture = ProcessInfo.processInfo.environment["HERMIT_BRIDGE_ORIGIN"] ?? ""
        guard !fixture.isEmpty else { throw XCTSkip("no HERMIT_BRIDGE_ORIGIN — see tools/bridge-fixture.sh") }

        app.launchArguments = ["-hermitOrigin", fixture]
        app.launch()

        // An empty keyring is the easy half of claim one — the sign-in gate is a
        // web page, so every arrangement of this app has ever opened on the page
        // here. Asserted anyway, because it is also what says the fixture server
        // is up before anything below blames the shell for its absence.
        XCTAssertTrue(
            app.webViews.buttons["keychain.clear"].waitForExistence(timeout: 30),
            "a cold start with no keyring did not open on the web app")

        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer")
        app.webViews.buttons["keychain.set — two machines"].tap()
        XCTAssertTrue(fixtureSays("keyring ok"), "the shell refused to store the keyring")
        app.webViews.buttons["keychain.setActive — m_two"].tap()
        XCTAssertTrue(fixtureSays("active m_two ok"), "the shell would not record which entry is active")

        // Claim one, on the case that actually distinguishes the two shapes: a
        // device WITH a keyring. Relaunched right here, and asserted with
        // nothing between it and `launch()` — no helper, no swipe, no URL — so
        // that it cannot be masked by something upstream of it failing first.
        // (It was, the first time this was counter-proved: the old front door
        // tripped `openPage()` three assertions earlier and the run never
        // reached the sentence that names the bug.)
        app.terminate()
        app.launch()
        XCTAssertTrue(
            app.webViews.buttons["keychain.clear"].waitForExistence(timeout: 30),
            "a cold start with a keyring on the device did not open on the web app — "
                + "the native list is the front door again")
        XCTAssertFalse(app.navigationBars["Sessions"].exists,
                       "a keyring on the device puts the native list in front of the page")

        // One good load. It is also the thing that writes the snapshot.
        openSessionList()
        XCTAssertTrue(screenSays("active key: m_two"), "the list did not load against a working key")

        // A tapped row brings the page forward. The list does not go looking for
        // a web view — it hands the path to whoever put it up — which is what
        // makes this survive the page being over it, under it, or (next
        // milestone) beside it in a drawer. The fixture has no router, so what
        // this checks is the shell's half.
        app.cells.element(boundBy: 0).tap()
        XCTAssertTrue(
            app.webViews.buttons["keychain.clear"].waitForExistence(timeout: 20),
            "tapping a row did not bring the page up")
        // And the row you opened is still the one marked when the list comes
        // back — `activeSessionId`, the web's `optimisticActiveId`. It lives on
        // the list instance, so this is also the assertion that the shell keeps
        // ONE of those rather than building a new one per `hermit://sessions`.
        openSessionList()
        XCTAssertTrue(screenSays("active key: m_two", timeout: 10), "the list did not come back")
        shoot("21-session-list-row-open")

        // Same two machines, tokens the fixture refuses.
        openPage()
        app.webViews.buttons["keychain.set — two machines, dead keys"].tap()
        XCTAssertTrue(fixtureSays("dead keyring ok"), "the shell refused to store the second keyring")

        app.terminate()
        app.launch()
        XCTAssertTrue(
            app.webViews.buttons["keychain.clear"].waitForExistence(timeout: 30),
            "the second cold start did not open on the web app either")

        // Claim two: opened from here, the list has rows on it before the fetch
        // could have answered — and the fetch behind them really did fail, which
        // is what makes the rows evidence.
        openSessionList()
        XCTAssertTrue(
            screenSays("active key: m_two", timeout: 10),
            "the list drew nothing — the snapshot never painted")
        // Dwell rather than sample: the 401 lands a beat later.
        Thread.sleep(forTimeInterval: 4)
        XCTAssertFalse(
            app.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS 'Could not load the session list'"))
                .firstMatch.exists,
            "the launch fetched successfully — this run proves nothing about the snapshot")
        XCTAssertTrue(screenSays("active key: m_two", timeout: 5),
                      "the failed refresh wiped the snapshot it was drawn over")
        shoot("20-session-list-from-snapshot")

        // Leave the install clean for whatever runs next.
        openPage()
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer at the end")
    }

    /// The native timeline, driven end to end on a phone: the window, a turn
    /// arriving while nobody touches the screen, and paging back to the
    /// beginning of the conversation.
    ///
    /// Everything below the view controller already had a fixture on the Mac —
    /// `TimelineMerge` and `TimelinePager` share a 39-case table with the web,
    /// `FoldRuns` a 97-case one, and `tools/render-timeline.sh` draws the rows in
    /// five seconds. What none of that touches is the wiring: whether the pill
    /// is ever offered, whether scrolling towards the far end actually fires a
    /// pull, whether a page lands in the right order, and whether the two
    /// transports are describing the same window. Those only exist on a device.
    ///
    /// The fixture answers `chat.listMessages`, `chat.listMessagesBefore` and
    /// `/api/chat/stream` for one 150-message session, and NAMES each row after
    /// the list it has to come out of — `window · row 91`, `history page 1 · row
    /// 90` — so the seam between the live window and paged history is readable
    /// in a screenshot instead of being a claim.
    ///
    /// Needs `HERMIT_BRIDGE_ORIGIN`; `tools/bridge-fixture.sh` provides it.
    func testTheNativeTimelineStreamsAndPagesBack() throws {
        let fixture = ProcessInfo.processInfo.environment["HERMIT_BRIDGE_ORIGIN"] ?? ""
        guard !fixture.isEmpty else { throw XCTSkip("no HERMIT_BRIDGE_ORIGIN — see tools/bridge-fixture.sh") }

        app.launchArguments = ["-hermitOrigin", fixture]
        app.launch()
        openPage()
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer")
        app.webViews.buttons["keychain.set — two machines"].tap()
        XCTAssertTrue(fixtureSays("keyring ok"), "the shell refused to store the keyring")
        app.webViews.buttons["keychain.setActive — m_two"].tap()
        XCTAssertTrue(fixtureSays("active m_two ok"), "the shell would not record which entry is active")
        openSessionList()

        // `hermit://timeline/<id>` — the only way to this screen today, and one
        // of the URL paths into this app that had never been walked once.
        XCUIDevice.shared.system.open(URL(string: "hermit://timeline/s_timeline")!)

        // The window landed, with the right key on the request and the window
        // the contract describes. A shell that reached for `list[0]`, asked for
        // the wrong limit, or dropped `digest` would draw a full and entirely
        // plausible conversation with nothing erroring anywhere.
        XCTAssertTrue(
            screenSays("window · key m_two · limit 60 · digest 1", timeout: 40),
            "the native timeline never drew its window — the deep link, the query or the key")
        // Acceptance criterion 2: no web view anywhere on this screen. The one
        // the scene owns is off the stack, so nothing of it should be in the
        // hierarchy.
        XCTAssertEqual(app.webViews.count, 0, "the native timeline has a web view in it")

        // The header. It is a second query — `chat.getSession`, not the list —
        // and every line below is a different reason to believe it ran.
        XCTAssertTrue(screenSays("getSession #", timeout: 25),
                      "the header never drew what chat.getSession said — the query, the key, or the decode")
        // The state line, out of the `activity` blob. `chat.listSessions`
        // deliberately never carries that blob, so a header wired to the list
        // could show a dot but never this string.
        XCTAssertTrue(screenSays("Bash · 47s", timeout: 20),
                      "the header has no live state line — sessionStatusView never saw the activity")
        // The RESOLVED backend, short-labelled the way a 390pt row needs.
        XCTAssertTrue(screenSays("Codex", timeout: 10), "the header does not name the backend")
        // `fmtBytes(214000)`. The bar beside it is amber only because
        // `contextWindowFor` used codex's 258,400 — against the 1M default the
        // same number is 21% and green.
        XCTAssertTrue(screenSays("214.0k", timeout: 10), "the header does not print the context count")
        // The title ladder really is a ladder: this session has a title AND a
        // preview, and the preview must not be what shows.
        XCTAssertFalse(screenSays("should never be read", timeout: 2),
                       "the header fell through to the preview even though the title is set")
        settle(); shoot("22-timeline-window")
        // Half of the "does it poll?" check. The other half is read minutes
        // later, at the end of the paging below — no sleep of its own, and a far
        // wider gap than one this test could afford to wait out. Nothing
        // between here and there may WAIT on this number: the stream assertions
        // that follow are catching transient states, and a pause put in front of
        // them is a pause that misses them (which is exactly how the first run
        // of this failed).
        let firstServe = headerNumber()
        XCTAssertNotNil(firstServe, "could not read the fixture's getSession counter off the header")

        // It moves on its own. Nothing between here and the next screenshot
        // touches the screen — a timeline that only changes when you scroll it
        // would satisfy every other assertion in this test. Asserted straight
        // after the window on purpose: the fixture rewrites this row, so it is a
        // state to catch rather than one to come back to.
        let opening = "stream · key m_two · limit 60 · digest 1 · skipInitial 1 · delta 1"
        XCTAssertTrue(screenSays(opening, timeout: 30),
                      "nothing arrived on the stream — or it asked for a different window than the query did")
        settle(); shoot("23-timeline-live-push")
        // The fold really ran over these rows: `m147` is thinking + a tool call
        // + its result, which has to read as one capsule named after the tool.
        XCTAssertTrue(screenSays("Bash", timeout: 10),
                      "the tool run in the window did not fold into a capsule")
        // The same id, rewritten. This is what a turn being written looks like,
        // and a diffable data source will not redraw a cell whose identifier did
        // not change — the bug the session list shipped in round 14.
        XCTAssertTrue(screenSays("rewritten in place · key m_two", timeout: 40),
                      "the second push never reached the screen")
        XCTAssertFalse(screenSays("stream · key", timeout: 3),
                       "the second push was drawn as a SECOND row instead of replacing the first")

        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 5), "the timeline is not a collection view")

        // Scroll back through the window. The list is upside down, so a
        // downward swipe walks towards OLDER rows, and crossing into the last
        // two screens of runway is what has to fire the pull — nobody taps the
        // pill in normal use.
        XCTAssertTrue(
            scroll(list, until: "history page 1 · row 90", swipes: 14, towardsOlder: true),
            "reaching the far end of the window never pulled a page of history")
        settle(); shoot("24-timeline-history-page")

        // The rows the live window shed while the reader was in history. The
        // fixture drops `m091`/`m092` out of the window a beat after serving
        // that page; if `adopt` did not hand them to the history list they are
        // gone from both lists, no amount of paging brings them back, and the
        // screen looks perfectly healthy. `window · row 91` is the row directly
        // above the seam, so this is a short scroll, not a hunt.
        XCTAssertTrue(
            scroll(list, until: "window · row 91", swipes: 6, towardsOlder: false),
            "the rows the stream dropped from the window never reached the history list")

        // All the way to the beginning of the session — a second page, served
        // short, which is what retires the pill. A pager that trusts only the
        // server's flag keeps offering it forever and fires a pull on every
        // scroll at the far end.
        XCTAssertTrue(
            scroll(list, until: "history page 2 · row 1", swipes: 24, towardsOlder: true),
            "the second page of history never arrived")
        XCTAssertFalse(
            screenSays("load earlier", timeout: 3),
            "the pill is still offered at the beginning of the conversation")
        settle(); shoot("25-timeline-beginning")
        // Parked at the oldest row, which is where the old shape was worst: with
        // the navigation bar translucent and the scroll edge effect turned off
        // in round 3, the first message drew straight through the title. The
        // header is opaque, so this shot is also the pixel evidence — see
        // `tools/header-band.sh`, which reads the strip out of this PNG.
        XCTAssertTrue(screenSays("getSession #", timeout: 10),
                      "the header went away once the reader scrolled into history")
        // The other half: the header has been polling `chat.getSession` on its
        // own the whole way through the paging above. One that queried once and
        // froze passes every other assertion here.
        let laterServe = headerNumber()
        XCTAssertNotNil(laterServe, "the header stopped saying which serve it is showing")
        XCTAssertGreaterThan(laterServe ?? 0, firstServe ?? 0,
                             "the header is not polling — it is still showing the serve it opened with")

        // Open it a second time and photograph the resting position. Every shot
        // above is taken somewhere the reader was steered to; this is the one a
        // person actually gets — parked on the newest message, with the safe
        // area on the ends they can see. It doubles as the check that leaving
        // the screen and coming back rebuilds it from nothing.
        openSessionList()
        // A beat before the deep link, unlike the first open above, which fires
        // it the instant the "Sessions" bar appears — i.e. while that screen's
        // own push is still animating. Both orders have to produce the same
        // screen, and having one of each here is cheaper than a test for it.
        settle()
        XCUIDevice.shared.system.open(URL(string: "hermit://timeline/s_timeline")!)
        XCTAssertTrue(screenSays("window · key m_two · limit 60 · digest 1", timeout: 30),
                      "the timeline did not come back on a second open")
        settle(); shoot("26-timeline-tail")

        // The header's own back control, which is the slot the web puts its
        // sidebar toggle in. Tested here rather than trusted: the navigation bar
        // is hidden on this screen, so this button and the edge swipe are the
        // only two ways off it, and `openPage()` below already covers the swipe.
        let back = app.buttons["back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "the header has no back control")
        back.tap()
        // One screen back, which from here is the session list: this test opened
        // the timeline off `hermit://timeline/<id>` while the list was on
        // screen, so the stack is page → list → timeline. Asserting the LIST and
        // not the page is the point — a "back" that jumped to the root would
        // pass a laxer check and be wrong.
        XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 20),
                      "tapping the header's back control did not pop one screen")

        // Leave the install clean for whatever runs next. Two screens deep, so
        // this is also the one place the edge swipe is asked to run twice.
        openPage()
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer at the end")
    }

    /// The composer: a draft that survives being killed, a send that shows its
    /// bubble before the server answers, the handover to the real row, and Stop.
    ///
    /// Everything here needs a phone. The draft lives in `UserDefaults` and only
    /// a real launch can lose it; the bubble handover is a race between a
    /// mutation and an SSE frame; and the Stop pill's whole design is about
    /// which pixels a thumb lands on. `tools/composer-fixture.sh` holds the
    /// DECISIONS against the web — this holds the wiring.
    func testTheNativeComposerSendsAndHandsTheBubbleOver() throws {
        let fixture = ProcessInfo.processInfo.environment["HERMIT_BRIDGE_ORIGIN"] ?? ""
        guard !fixture.isEmpty else { throw XCTSkip("no HERMIT_BRIDGE_ORIGIN — see tools/bridge-fixture.sh") }

        app.launchArguments = ["-hermitOrigin", fixture]
        app.launch()
        openPage()
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer")
        app.webViews.buttons["keychain.set — two machines"].tap()
        XCTAssertTrue(fixtureSays("keyring ok"), "the shell refused to store the keyring")
        app.webViews.buttons["keychain.setActive — m_two"].tap()
        XCTAssertTrue(fixtureSays("active m_two ok"), "the shell would not record which entry is active")

        XCUIDevice.shared.system.open(URL(string: "hermit://timeline/s_timeline")!)
        XCTAssertTrue(screenSays("window · key m_two · limit 60 · digest 1", timeout: 40),
                      "the native timeline never drew its window")

        let box = composerField()
        XCTAssertTrue(box.waitForExistence(timeout: 10), "the timeline has no composer")

        // ── the draft outlives the process ───────────────────────────────────
        //
        // Typed, NOT sent, then the app is killed the way iOS kills it. A draft
        // held only in a view's state is gone by the next line and every other
        // assertion in this test still passes.
        box.tap()
        box.typeText("draft that has to survive")
        XCTAssertTrue(boxSays("draft that has to survive"),
                      "what was typed never reached the box")
        app.terminate()
        app.launch()
        XCUIDevice.shared.system.open(URL(string: "hermit://timeline/s_timeline")!)
        XCTAssertTrue(screenSays("window · key m_two", timeout: 40),
                      "the timeline did not come back after the relaunch")
        XCTAssertTrue(boxSays("draft that has to survive", timeout: 15),
                      "the draft did not survive a relaunch — hermit:draft:<sid> was never written, or never read")
        settle(); shoot("27-composer-draft-restored")

        // Clear it from the ✕ rather than by selecting and deleting: that button
        // is the only way to empty the box on a phone, and it is one of the two
        // controls the slot beside the field holds.
        app.buttons["clear draft"].tap()
        XCTAssertFalse(boxSays("draft that has to survive", timeout: 3),
                       "the ✕ did not empty the box")

        // ── send ─────────────────────────────────────────────────────────────
        // ASCII on purpose. `typeText` drives the simulator's keyboard, and a CJK
        // string through it depends on the host's hardware keyboard being
        // connected — a flake with nothing to do with what is under test. What
        // the box does with 中文 is checked where it can be checked without a
        // keyboard: `tools/render-composer.sh` draws it, and
        // `tools/composer-fixture.sh` runs the trimming over it.
        let typed = "first native send"
        let box2 = composerField()
        box2.tap()
        box2.typeText(typed)
        let send = app.buttons["composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "the composer has no send button")
        XCTAssertTrue(send.isEnabled, "the send button is dead with a draft in the box")
        settle(); shoot("28-composer-typed")
        send.tap()

        // The bubble is on screen BEFORE the server has said anything, and the
        // box is empty. Both halves matter: a composer that waits for a round
        // trip reads as broken, and one that clears late sends twice.
        XCTAssertTrue(screenSays(typed, timeout: 10),
                      "the optimistic bubble never appeared — the send is waiting on the network")
        settle(); shoot("29-composer-optimistic")

        // The real row lands a beat later, and it says something DIFFERENT from
        // what was typed — which is the case a text match cannot survive (the
        // dashboard's outgoing auto-translate rewrites a message exactly this
        // way). The bubble has to be handed over by the id `chat.send` answered
        // with. If it were matched by text, both rows would be on screen now.
        XCTAssertTrue(screenSays("server #1 · " + typed, timeout: 25),
                      "the row chat.send wrote never arrived on the stream")
        XCTAssertFalse(screenStillHas(typed, excluding: "server #"),
                       "the optimistic bubble is still there beside its real row — dropLanded matched on text, not on the id")
        settle(); shoot("30-composer-handed-over")

        // A second send, so the two idempotency keys have to differ: the fixture
        // mints `server #N` once per NEW clientId and replays the stored row for
        // a repeat, so a shell that reused one key would draw `server #1` twice.
        let box3 = composerField()
        box3.tap()
        box3.typeText("second")
        app.buttons["composer.send"].tap()
        XCTAssertTrue(screenSays("server #2 · second", timeout: 25),
                      "the second send reused the first send's clientId — the server replayed row #1")

        // ── Stop ─────────────────────────────────────────────────────────────
        //
        // The fixture's session is `working`, so the pill is up. It is a
        // LABELLED pill and not a second circle, which is why this asks for it
        // by name.
        let stop = app.buttons["stop this turn"]
        XCTAssertTrue(stop.waitForExistence(timeout: 10),
                      "no Stop pill on a working session")
        // The 400ms arm delay: a tap that arrives before the pill has been on
        // screen long enough to have been aimed at is swallowed. It has been up
        // since the window landed, so this one is not.
        stop.tap()
        // The header carries the fixture's cancel count and re-polls every five
        // seconds, so this is the mutation actually reaching the server rather
        // than a button that looked pressed.
        XCTAssertTrue(screenSays("cancels 1", timeout: 25),
                      "tapping Stop never reached chat.cancelTurn")
        settle(); shoot("31-composer-stopped")

        openPage()
        app.webViews.buttons["keychain.clear"].tap()
        XCTAssertTrue(fixtureSays("keychain.clear ok"), "keychain.clear did not answer at the end")
    }

    // MARK: - helpers
    /// Let the list stop moving before a screenshot.
    ///
    /// Every shot in this test is taken the instant an assertion passed, which
    /// is mid-push-transition for the first one and mid-deceleration for the
    /// rest. A collection view with self-sizing cells is genuinely still moving
    /// then — cells recycling, heights being corrected — and a screenshot of it
    /// shows holes that are not in the finished layout. These images are the
    /// evidence a reviewer looks at, so they are taken of a settled screen.
    private func settle() { Thread.sleep(forTimeInterval: 3) }

    /// The composer's text box.
    ///
    /// Asked for as a text VIEW first and a text FIELD second: SwiftUI's
    /// `TextField(axis: .vertical)` is a multi-line control and surfaces as
    /// either depending on the OS build, and hard-coding one of them is a test
    /// that starts failing on an iOS update for no reason anybody can see.
    private func composerField() -> XCUIElement {
        let asView = app.textViews["composer.field"]
        return asView.exists ? asView : app.textFields["composer.field"]
    }

    /// What the composer's box currently holds.
    ///
    /// A text control's contents are its `value`, not its `label` — `screenSays`
    /// scans labels and cannot see a draft at all, which is exactly how the
    /// first run of this test failed. An EMPTY box's value is its placeholder,
    /// UIKit's own convention, so this is only ever asked about text that was
    /// typed.
    private func boxSays(_ needle: String, timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let v = composerField().value as? String, v.contains(needle) { return true }
            Thread.sleep(forTimeInterval: 0.25)
        } while Date() < deadline
        return false
    }

    /// Swipe until something shows up, or give up and say so.
    ///
    /// `towardsOlder` is a downward swipe, because the collection view is
    /// flipped: the finger moves the way it does in any chat app, and the
    /// scroll view underneath is walking towards the END of its content.
    private func scroll(_ list: XCUIElement, until needle: String,
                        swipes: Int, towardsOlder: Bool) -> Bool {
        for _ in 0..<swipes {
            if screenSays(needle, timeout: 0.5) { return true }
            if towardsOlder { list.swipeDown() } else { list.swipeUp() }
        }
        // One last look with a real timeout: the final swipe may still be
        // settling, and a page requested by it may still be in flight.
        return screenSays(needle, timeout: 6)
    }


    /// The number the fixture stamped on the answer this screen is showing.
    ///
    /// Scans labels rather than asking for a text element, for the same reason
    /// `screenSays` does — a `UIHostingConfiguration` row may come back as one
    /// merged element or as its separate texts.
    private func pollNumber() -> Int? {
        let match = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS 'poll #'"))
        for i in 0..<match.count {
            let label = match.element(boundBy: i).label
            guard let r = label.range(of: "poll #[0-9]+", options: .regularExpression) else { continue }
            return Int(label[r].dropFirst("poll #".count))
        }
        return nil
    }

    /// The fixture's `chat.getSession` serve number, off the header's title.
    private func headerNumber() -> Int? {
        let match = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS 'getSession #'"))
        for i in 0..<match.count {
            let label = match.element(boundBy: i).label
            guard let r = label.range(of: "getSession #[0-9]+", options: .regularExpression) else { continue }
            return Int(label[r].dropFirst("getSession #".count))
        }
        return nil
    }

    /// The session list, from wherever this test happens to be.
    ///
    /// It is not the root — the page is — so this is a URL, the same one a
    /// person would have no way to type. That is the point of the URL: until
    /// the sidebar drawer is native there is no gesture into this screen, and a
    /// screen with no way in cannot be driven on a phone.
    private func openSessionList() {
        if app.navigationBars["Sessions"].exists { return }
        XCUIDevice.shared.system.open(URL(string: "hermit://sessions")!)
        XCTAssertTrue(
            app.navigationBars["Sessions"].waitForExistence(timeout: 15),
            "hermit://sessions did not bring the native list up")
    }

    /// The fixture page, from wherever this test happens to be.
    ///
    /// The page is the root again, so a launch lands here on its own and the
    /// only case with anything to do is "a native screen is in front of it".
    /// Getting off one is the edge swipe, and doing it that way rather than
    /// with a URL is deliberate: it is the only assertion anywhere that UIKit's
    /// back gesture still runs on a pushed native screen after the shell handed
    /// the left edge back to the page.
    private func openPage() {
        for _ in 0..<3 {
            if app.webViews.buttons["keychain.clear"].waitForExistence(timeout: 4) { return }
            edgeSwipeBack()
        }
        XCTAssertTrue(
            app.webViews.buttons["keychain.clear"].waitForExistence(timeout: 30),
            "three edge swipes and the page is still not on screen. Either the fixture "
                + "server stopped, or the page is not at the bottom of the stack any more "
                + "— a swipe on the root view controller pops nothing.")
    }

    /// One interactive pop, driven the way a thumb does it.
    ///
    /// A short press before the drag: an instantaneous one is a flick that UIKit
    /// can read as a scroll rather than a screen-edge pan.
    private func edgeSwipeBack() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.002, dy: 0.5))
            .press(forDuration: 0.05,
                   thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)))
    }

    /// Anything on screen whose label contains this.
    ///
    /// Not `staticTexts[…]`: a `UIHostingConfiguration` cell may expose a row as
    /// one merged accessibility element or as its separate texts depending on
    /// the build, and what these assertions are about is the words, not the
    /// shape of the tree.
    private func screenSays(_ needle: String, timeout: TimeInterval = 20) -> Bool {
        let match = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", needle))
        return match.firstMatch.waitForExistence(timeout: timeout)
    }

    /// Wait for the fixture's result line to mention something. Substring rather
    /// than equality: the line carries the method and the shell's own sentence,
    /// and the assertion is about the sentence.
    /// Is anything on screen carrying `needle` that is NOT the real row?
    ///
    /// Equality against the whole label would be the obvious check and it is the
    /// wrong one: a `UIHostingConfiguration` row can come back as one merged
    /// element carrying the message AND its clock, so `label == typed` would be
    /// false whether the bubble is there or not — an assertion that passes for
    /// the wrong reason. Excluding the real row's marker asks the question that
    /// is actually being asked.
    private func screenStillHas(_ needle: String, excluding marker: String) -> Bool {
        let p = NSPredicate(format: "label CONTAINS %@ AND NOT (label CONTAINS %@)", needle, marker)
        return app.descendants(matching: .any).matching(p).firstMatch.waitForExistence(timeout: 3)
    }

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
