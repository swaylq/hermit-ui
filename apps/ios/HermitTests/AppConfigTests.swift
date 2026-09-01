import XCTest
@testable import Hermit

/// `AppConfig.isInternal` decides whether a URL stays in the app or is thrown to
/// Safari. Get it wrong in one direction and a second deployment's pages leave the
/// shell (and its storage jar); wrong in the other and a look-alike domain gets to
/// render inside the app. Both directions are tested here.
final class AppConfigTests: XCTestCase {
    override func setUp() {
        super.setUp()
        AppConfig.setKnownHosts([])
    }

    override func tearDown() {
        AppConfig.setKnownHosts([])
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
}
