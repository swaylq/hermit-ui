// Drives the Swift port of the `+` button's decisions over the table the WEB
// produced.
//
//     apps/ios/tools/attach-fixture.sh
//
// Every expectation in `tools/fixtures/attach-cases.json` came out of running
// the dashboard's own `getExt` / `isSafeFileName` / `unsupportedTypeError` /
// `attachName` / `occupiedSlots` / `admitFiles` / `capsCaption` / `readyLabel` /
// `chipSubLabel` (scripts/gen-attach-fixture.ts), so nothing here encodes a
// belief about what the answer should be — a red line is always "the two
// implementations disagree", never "the test author disagrees".
import Foundation

// MARK: - The table

struct Fixture: Decodable {
    struct Name: Decodable {
        var why: String
        var name: String
        var ext: String
        var safe: Bool
        var error: String
        var asImage: String
        var asFile: String
    }
    struct Slot: Decodable {
        var kind: String
        var isImage: Bool
    }
    struct Occupied: Decodable {
        var images: Int
        var files: Int
    }
    struct Expected: Decodable {
        var accepted: [Int]
        var notice: String?
    }
    struct Admit: Decodable {
        var why: String
        var incoming: [Bool]
        var existing: [Slot]
        var occupied: Occupied
        var expected: Expected
    }
    struct Segment: Decodable {
        var text: String
        var atCap: Bool
    }
    struct Caps: Decodable {
        var images: Int
        var files: Int
        var expected: [Segment]
    }
    struct Label: Decodable {
        var why: String
        var isImage: Bool
        var name: String
        var mimeType: String
        var width: Int?
        var height: Int?
        var expected: String
        var chip: String
    }
    struct Err: Decodable {
        var why: String
        var error: String
        var expected: String
    }

    var maxImages: Int
    var maxFiles: Int
    var capsSeparator: String
    var safeFileExts: [String]
    var fileAccept: String
    var uploadingLabel: String
    var names: [Name]
    var admit: [Admit]
    var caps: [Caps]
    var labels: [Label]
    var errors: [Err]
}

// MARK: - Running it

var checks = 0
var failures: [String] = []

func expect<T: Equatable>(_ got: T, _ want: T, _ what: String) {
    checks += 1
    if got != want { failures.append("\(what)\n      got  \(got)\n      want \(want)") }
}

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath
let path = URL(fileURLWithPath: "\(root)/tools/fixtures/attach-cases.json")
guard let data = try? Data(contentsOf: path) else {
    FileHandle.standardError.write("cannot read \(path.path)\n".data(using: .utf8)!)
    exit(2)
}

let fixture: Fixture
do { fixture = try JSONDecoder().decode(Fixture.self, from: data) }
catch { FileHandle.standardError.write("fixture will not decode: \(error)\n".data(using: .utf8)!); exit(2) }

// ── the constants the table was BUILT with ──────────────────────────────────

expect(AttachCore.maxImages, fixture.maxImages, "MAX_IMAGES")
expect(AttachCore.maxFiles, fixture.maxFiles, "MAX_FILES")
expect(AttachCore.capsSeparator, fixture.capsSeparator, "CAPS_SEPARATOR")
// The list AS A LIST. A set comparison would pass while the two were in a
// different order, and `fileAccept` — the string the web actually puts in the
// DOM — is built from that order.
expect(AttachCore.safeFileExts, fixture.safeFileExts, "SAFE_FILE_EXTS (order included)")
expect(AttachCore.fileAccept, fixture.fileAccept, "FILE_ACCEPT")
expect(AttachCore.chipSubLabel(.uploading), fixture.uploadingLabel, "the uploading sub-label")

// ── getExt / isSafeFileName / unsupportedTypeError / attachName ─────────────

for c in fixture.names {
    expect(AttachCore.ext(of: c.name), c.ext, "getExt — \(c.why)")
    expect(AttachCore.isSafeFileName(c.name), c.safe, "isSafeFileName — \(c.why)")
    expect(AttachCore.unsupportedTypeError(c.name), c.error, "unsupportedTypeError — \(c.why)")
    expect(AttachCore.name(c.name, isImage: true), c.asImage, "attachName(image) — \(c.why)")
    expect(AttachCore.name(c.name, isImage: false), c.asFile, "attachName(file) — \(c.why)")
}

// ── occupiedSlots / admitFiles ──────────────────────────────────────────────

for c in fixture.admit {
    let existing = c.existing.map {
        AttachCore.Slot(kind: AttachCore.Kind(rawValue: $0.kind) ?? .ready, isImage: $0.isImage)
    }
    let live = AttachCore.occupiedSlots(existing)
    expect([live.images, live.files], [c.occupied.images, c.occupied.files], "occupiedSlots — \(c.why)")
    let got = AttachCore.admit(c.incoming, existing: existing)
    expect(got, AttachCore.Admission(accepted: c.expected.accepted, notice: c.expected.notice),
           "admitFiles — \(c.why)")
}

// ── capsCaption ─────────────────────────────────────────────────────────────

for c in fixture.caps {
    let got = AttachCore.capsCaption(images: c.images, files: c.files)
    let want = c.expected.map { AttachCore.CapSegment(text: $0.text, atCap: $0.atCap) }
    expect(got, want, "capsCaption(\(c.images), \(c.files))")
}

// ── readyLabel / chipSubLabel ───────────────────────────────────────────────

for c in fixture.labels {
    let ready = AttachCore.Ready(isImage: c.isImage, name: c.name, mimeType: c.mimeType,
                                 width: c.width, height: c.height)
    expect(AttachCore.readyLabel(ready), c.expected, "readyLabel — \(c.why)")
    expect(AttachCore.chipSubLabel(.ready(ready)), c.chip, "chipSubLabel(ready) — \(c.why)")
}

for c in fixture.errors {
    expect(AttachCore.chipSubLabel(.failed(c.error)), c.expected, "chipSubLabel(error) — \(c.why)")
}

// MARK: - Report

if failures.isEmpty {
    print("attach fixture: \(checks) checks, all agree with the web")
    exit(0)
}
print("attach fixture: \(checks) checks, \(failures.count) DISAGREE\n")
for f in failures { print("  ✗ \(f)") }
exit(1)
