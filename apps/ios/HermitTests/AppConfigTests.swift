import XCTest
@testable import Hermit

/// Two things here can be wrong in a way no screenshot would show.
///
/// `AppConfig.isInternal` decides whether a URL stays in the app or is thrown to
/// Safari. Get it wrong in one direction and a second deployment's pages leave the
/// shell (and its storage jar); wrong in the other and a look-alike domain gets to
/// render inside the app.
///
/// `AppConfig.normalizeOrigin` decides what the shell will accept as its own
/// backend. Everything the app sends — including the machine key, as a request
/// header — goes to whatever it returns.
final class AppConfigTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AppConfig.setKnownHosts([])
        // Not just tidiness: UserDefaults survives between runs in the simulator,
        // so an override left behind by a crashed run would silently move every
        // `AppConfig.host` below.
        AppConfig.clearOrigin()
    }

    override func tearDown() {
        AppConfig.setKnownHosts([])
        AppConfig.clearOrigin()
        super.tearDown()
    }

    private func url(_ s: String) -> URL {
        guard let u = URL(string: s) else {
            XCTFail("not a URL: \(s)")
            return URL(string: "https://invalid.example")!
        }
        return u
    }

    // MARK: - the shell's own origin

    func testOwnHostIsInternal() {
        XCTAssertTrue(AppConfig.isInternal(url("https://\(AppConfig.host)/chat")))
    }

    func testSubdomainOfOwnHostIsInternal() {
        XCTAssertTrue(AppConfig.isInternal(url("https://a.\(AppConfig.host)/x")))
    }

    /// The reason `belongs(_:to:)` inserts a dot: a naive `hasSuffix(host)` says
    /// yes to a domain that merely ENDS with the same letters.
    func testLookAlikeSuffixIsNotInternal() {
        XCTAssertFalse(AppConfig.isInternal(url("https://evil\(AppConfig.host)/x")))
    }

    func testUnrelatedHostIsNotInternal() {
        XCTAssertFalse(AppConfig.isInternal(url("https://example.com/x")))
    }

    func testUrlWithoutAHostIsNotInternal() {
        XCTAssertFalse(AppConfig.isInternal(url("mailto:someone@example.com")))
    }

    // MARK: - a second deployment (docs/multi-deployment-design.md)

    func testKnownDeploymentIsInternal() {
        AppConfig.setKnownHosts(["https://hermit.zhinan.tech"])
        XCTAssertTrue(AppConfig.isInternal(url("https://hermit.zhinan.tech/uploads/a.png")))
    }

    func testSubdomainOfKnownDeploymentIsInternal() {
        AppConfig.setKnownHosts(["https://zhinan.tech"])
        XCTAssertTrue(AppConfig.isInternal(url("https://hermit.zhinan.tech/uploads/a.png")))
    }

    func testLookAlikeOfKnownDeploymentIsNotInternal() {
        AppConfig.setKnownHosts(["https://hermit.zhinan.tech"])
        XCTAssertFalse(AppConfig.isInternal(url("https://evilhermit.zhinan.tech/x")))
    }

    func testDeploymentNotInTheKeyringIsNotInternal() {
        AppConfig.setKnownHosts(["https://hermit.zhinan.tech"])
        XCTAssertFalse(AppConfig.isInternal(url("https://other.example/x")))
    }

    func testHostComparisonIgnoresCase() {
        AppConfig.setKnownHosts(["https://HERMIT.Zhinan.TECH"])
        XCTAssertTrue(AppConfig.isInternal(url("https://hermit.zhinan.tech/x")))
    }

    /// The web layer sends the WHOLE list every time, so a removed machine must
    /// stop being internal rather than linger.
    func testSetKnownHostsReplacesRatherThanAccumulates() {
        AppConfig.setKnownHosts(["https://one.example"])
        AppConfig.setKnownHosts(["https://two.example"])
        XCTAssertFalse(AppConfig.isInternal(url("https://one.example/x")))
        XCTAssertTrue(AppConfig.isInternal(url("https://two.example/x")))
    }

    func testGarbageOriginsAreDroppedNotGuessedAt() {
        AppConfig.setKnownHosts(["", "not a url", "/relative/path", "https://good.example"])
        XCTAssertEqual(AppConfig.knownHosts, ["good.example"])
    }

    /// The shell's own origin never depends on what the page said.
    func testOwnHostSurvivesAnEmptyList() {
        AppConfig.setKnownHosts([])
        XCTAssertTrue(AppConfig.isInternal(url("https://\(AppConfig.host)/chat")))
    }

    // MARK: - normalizeOrigin (ported from normalizeBase, api-base.ts:28-44)

    private func assertOrigin(_ raw: String, _ expected: String,
                              file: StaticString = #filePath, line: UInt = #line) {
        do {
            let url = try AppConfig.normalizeOrigin(raw)
            XCTAssertEqual(url.absoluteString, expected, "input: \(raw)", file: file, line: line)
        } catch {
            XCTFail("'\(raw)' was refused: \(error.localizedDescription)", file: file, line: line)
        }
    }

    private func assertRefused(_ raw: String, _ message: String,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try AppConfig.normalizeOrigin(raw), "input: \(raw)",
                             file: file, line: line) { error in
            XCTAssertEqual((error as? AppConfig.OriginError)?.message, message,
                           "input: \(raw)", file: file, line: line)
        }
    }

    /// The common case: someone types a host, not a URL.
    func testBareHostBecomesHttps() {
        assertOrigin("hermit.zhinan.tech", "https://hermit.zhinan.tech")
    }

    func testBareHostWithPortBecomesHttps() {
        assertOrigin("hermit.zhinan.tech:8443", "https://hermit.zhinan.tech:8443")
    }

    func testTrailingSlashIsFine() {
        assertOrigin("https://hermit.zhinan.tech/", "https://hermit.zhinan.tech")
    }

    func testSurroundingWhitespaceIsTrimmed() {
        assertOrigin("  https://hermit.zhinan.tech  ", "https://hermit.zhinan.tech")
    }

    /// Two spellings of one deployment must not produce two different `host`
    /// values — that is what the microphone check compares.
    func testHostIsLowercased() {
        assertOrigin("HTTPS://Hermit.Zhinan.TECH", "https://hermit.zhinan.tech")
    }

    func testDefaultPortIsDropped() {
        assertOrigin("https://hermit.zhinan.tech:443", "https://hermit.zhinan.tech")
        assertOrigin("http://localhost:80", "http://localhost")
    }

    func testNonDefaultPortIsKept() {
        assertOrigin("http://localhost:4102", "http://localhost:4102")
    }

    /// `https://real.host@evil.example` reads as the real host and resolves to the
    /// other one. Rebuilding the origin from its parts drops the disguise.
    func testEmbeddedCredentialsAreDropped() {
        assertOrigin("https://dash.swaylab.ai@evil.example", "https://evil.example")
    }

    // MARK: - what normalizeOrigin refuses

    func testEmptyIsRefused() {
        assertRefused("", "backend address is empty")
        assertRefused("   ", "backend address is empty")
    }

    func testGarbageIsRefused() {
        assertRefused("not a url", "backend address is not a URL")
        assertRefused("https://", "backend address is not a URL")
    }

    /// The message is the "no path" one rather than the "must be http(s)" one, on
    /// both sides and for the same reason: anything that does not already start
    /// with `http(s)://` gets `https://` glued in front of it FIRST, so `ftp://x`
    /// parses as host `ftp` plus path `//x`. Verified against the real
    /// `normalizeBase` before this expectation was written down. Refused either
    /// way, which is what matters.
    func testNonHttpSchemeIsRefused() {
        assertRefused("ftp://hermit.zhinan.tech", "backend address must be a bare origin, no path")
        assertRefused("hermit://session/abc", "backend address must be a bare origin, no path")
    }

    /// The one that matters: plain http on a public host would put the machine key
    /// on the wire in clear text.
    func testPlainHttpIsRefusedOffLocalhost() {
        assertRefused("http://hermit.zhinan.tech",
                      "backend address must be https (http is only allowed for localhost)")
        assertRefused("http://192.168.2.10:4101",
                      "backend address must be https (http is only allowed for localhost)")
    }

    func testPlainHttpIsAllowedOnLoopback() {
        assertOrigin("http://localhost:4102", "http://localhost:4102")
        assertOrigin("http://127.0.0.1:4102", "http://127.0.0.1:4102")
        assertOrigin("http://[::1]:4102", "http://[::1]:4102")
    }

    /// A pasted deep link is the likeliest typo, and silently keeping the path
    /// would make every API call relative to it.
    func testPathQueryOrFragmentIsRefused() {
        assertRefused("https://hermit.zhinan.tech/chat", "backend address must be a bare origin, no path")
        assertRefused("https://hermit.zhinan.tech/?m=abc", "backend address must be a bare origin, no path")
        assertRefused("https://hermit.zhinan.tech/#x", "backend address must be a bare origin, no path")
    }

    func testOutOfRangePortIsRefused() {
        assertRefused("https://hermit.zhinan.tech:99999", "backend address is not a URL")
    }

    /// A port WebKit will not open is the worst kind of bad address, because it
    /// does NOT fail: WebKit commits an empty document, no navigation delegate
    /// fires, the offline screen never appears and the app is simply white with
    /// no way back. Refusing it at the point it is typed is the whole fix.
    func testBlockedPortIsRefused() {
        assertRefused("https://hermit.zhinan.tech:9",
                      "backend address port 9 is blocked (browsers refuse to open it)")
        assertRefused("http://localhost:6000",
                      "backend address port 6000 is blocked (browsers refuse to open it)")
        // A bare host with a blocked port gets `https://` first, then refused —
        // it must not slip past by taking a different route through the parser.
        assertRefused("hermit.zhinan.tech:22",
                      "backend address port 22 is blocked (browsers refuse to open it)")
    }

    /// The list has gaps that look like transcription mistakes and are not: 104
    /// and 109 are blocked while 105-108 and 112 are fine. Pinned so that
    /// "tidying" the ranges shows up as a failing test rather than as an address
    /// the user can no longer enter.
    func testTheBlockedListIsNotTidyRanges() {
        assertOrigin("https://hermit.zhinan.tech:105", "https://hermit.zhinan.tech:105")
        assertOrigin("https://hermit.zhinan.tech:112", "https://hermit.zhinan.tech:112")
        assertRefused("https://hermit.zhinan.tech:104",
                      "backend address port 104 is blocked (browsers refuse to open it)")
        assertRefused("https://hermit.zhinan.tech:109",
                      "backend address port 109 is blocked (browsers refuse to open it)")
        XCTAssertEqual(AppConfig.blockedPorts.count, 82)
    }

    /// The ports a real deployment actually uses have to survive all of this.
    func testOrdinaryPortsStillPass() {
        assertOrigin("https://hermit.zhinan.tech:8443", "https://hermit.zhinan.tech:8443")
        assertOrigin("http://localhost:4101", "http://localhost:4101")
        assertOrigin("http://localhost:4102", "http://localhost:4102")
    }

    // MARK: - setting, reading back and clearing the origin

    func testSetOriginMovesTheShell() throws {
        try AppConfig.setOrigin("hermit.zhinan.tech")
        XCTAssertEqual(AppConfig.origin.absoluteString, "https://hermit.zhinan.tech")
        XCTAssertEqual(AppConfig.host, "hermit.zhinan.tech")
        XCTAssertEqual(AppConfig.userOrigin?.absoluteString, "https://hermit.zhinan.tech")
    }

    /// The whole point of M0: after the move, the new host has to be the one the
    /// microphone check and the in-app/Safari split accept.
    func testTheNewOriginIsTheInternalOne() throws {
        try AppConfig.setOrigin("hermit.zhinan.tech")
        XCTAssertTrue(AppConfig.isInternal(url("https://hermit.zhinan.tech/chat")))
        XCTAssertTrue(AppConfig.isInternal(url("https://a.hermit.zhinan.tech/chat")))
        XCTAssertFalse(AppConfig.isInternal(url("https://dash.swaylab.ai/chat")))
    }

    func testClearOriginGoesBackToTheShippedUrl() throws {
        try AppConfig.setOrigin("hermit.zhinan.tech")
        AppConfig.clearOrigin()
        XCTAssertEqual(AppConfig.origin, AppConfig.defaultOrigin)
        XCTAssertNil(AppConfig.userOrigin)
    }

    func testUnsetOriginIsTheShippedUrl() {
        XCTAssertEqual(AppConfig.origin, AppConfig.defaultOrigin)
        XCTAssertNil(AppConfig.userOrigin)
    }

    /// A refused address must leave the shell where it was, not half-move it.
    func testARefusedAddressChangesNothing() {
        XCTAssertThrowsError(try AppConfig.setOrigin("http://evil.example"))
        XCTAssertEqual(AppConfig.origin, AppConfig.defaultOrigin)
        XCTAssertNil(AppConfig.userOrigin)
    }

    /// Defaults outlive the app, and the rules can tighten between versions. A
    /// stored value that no longer passes is ignored, not obeyed.
    func testAStoredValueThatNoLongerValidatesIsIgnored() {
        UserDefaults.standard.set("http://evil.example", forKey: AppConfig.userOriginKey)
        XCTAssertNil(AppConfig.userOrigin)
        AppConfig.clearOrigin()
        XCTAssertEqual(AppConfig.origin, AppConfig.defaultOrigin)
    }

    /// `setOrigin` stores the NORMALIZED string, so a later read cannot disagree
    /// with what the shell actually loaded.
    func testWhatIsStoredIsWhatWasNormalized() throws {
        try AppConfig.setOrigin("  HERMIT.zhinan.tech:443/  ")
        XCTAssertEqual(UserDefaults.standard.string(forKey: AppConfig.userOriginKey),
                       "https://hermit.zhinan.tech")
    }
}
