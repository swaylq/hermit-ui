import AppKit

// Compare two PNGs pixel by pixel and say WHERE they differ, not just whether.
//
//   swiftc -O -o png-diff tools/png-diff.swift && ./png-diff a.png b.png [out.png]
//
// Built for tools/pixel-compare.sh: the native session list against the web one.
// Two things it deliberately does NOT do — it does not resize (a size difference
// is a finding, not a nuisance to smooth over) and it does not blur or
// perceptually weight anything (an "acceptable" threshold is a decision for
// whoever reads the report, so the numbers stay raw).
//
// The band report is the part that earns its keep. A whole-image percentage tells
// you the two drawings disagree; the per-row bands tell you it is row 4 and the
// clock column, which is the difference between a number and a lead.

func load(_ path: String) -> NSBitmapImageRep? {
    guard let data = FileManager.default.contents(atPath: path),
          let rep = NSBitmapImageRep(data: data) else { return nil }
    // Force one predictable layout: 8-bit RGBA, sRGB, no premultiplication
    // surprises. Two PNGs written by ImageRenderer and by Chrome do not otherwise
    // agree on colour space, and a channel-by-channel compare of two different
    // colour spaces measures the difference between the readers.
    guard let converted = rep.converting(to: .sRGB, renderingIntent: .default) else { return rep }
    return converted
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: png-diff <a.png> <b.png> [out.png]\n".utf8))
    exit(2)
}
guard let a = load(args[1]) else {
    FileHandle.standardError.write(Data("cannot read \(args[1])\n".utf8)); exit(2)
}
guard let b = load(args[2]) else {
    FileHandle.standardError.write(Data("cannot read \(args[2])\n".utf8)); exit(2)
}

let aw = a.pixelsWide, ah = a.pixelsHigh
let bw = b.pixelsWide, bh = b.pixelsHigh
print("A \(args[1].split(separator: "/").last ?? "")  \(aw)x\(ah)")
print("B \(args[2].split(separator: "/").last ?? "")  \(bw)x\(bh)")
if aw != bw || ah != bh {
    print("SIZE MISMATCH — comparing the \(min(aw, bw))x\(min(ah, bh)) they share")
}
let w = min(aw, bw), h = min(ah, bh)

// A pixel "differs" when any channel is off by more than this. 2/255 absorbs the
// rounding two independent rasterisers do on the same colour and nothing else;
// see the 0.12% at delta 1 measured in round 9.
let TOL = 2

var differing = 0
var maxDelta = 0
var bandDiff = [Int](repeating: 0, count: (h + 15) / 16)
let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                           isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: w * 4, bitsPerPixel: 32)!
// Straight into the buffer rather than through setColor(_:atX:y:). That call
// wants to convert an NSColor into the rep's space, logs "Unrecognized colorspace
// number -1" once per pixel, and — the part that actually matters — leaves the
// image blank: the first heat map this program wrote was a white rectangle while
// the statistics underneath it were correct. Bytes cannot go wrong that way, and
// they are two orders of magnitude faster.
let buf = out.bitmapData!
let stride = out.bytesPerRow
@inline(__always) func put(_ x: Int, _ y: Int, _ r: UInt8, _ g: UInt8, _ b: UInt8) {
    let o = y * stride + x * 4
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255
}

for y in 0..<h {
    for x in 0..<w {
        let pa = a.colorAt(x: x, y: y) ?? .black
        let pb = b.colorAt(x: x, y: y) ?? .black
        let d = max(
            abs(Int(pa.redComponent * 255) - Int(pb.redComponent * 255)),
            max(abs(Int(pa.greenComponent * 255) - Int(pb.greenComponent * 255)),
                abs(Int(pa.blueComponent * 255) - Int(pb.blueComponent * 255))))
        maxDelta = max(maxDelta, d)
        if d > TOL {
            differing += 1
            bandDiff[y / 16] += 1
            // Red where they disagree, the A image dimmed underneath where they
            // agree — so the heat map is still legible as the thing it is of.
            put(x, y, 255, 26, 64)
        } else {
            put(x, y, UInt8(pa.redComponent * 89), UInt8(pa.greenComponent * 89),
                UInt8(pa.blueComponent * 89))
        }
    }
}

let total = w * h
let pct = Double(differing) / Double(total) * 100
print(String(format: "differing pixels: %d / %d  (%.2f%%)  max channel delta: %d  tolerance: ±%d",
             differing, total, pct, maxDelta, TOL))

print("worst 16px bands (y range → % of the band that differs):")
let ranked = bandDiff.enumerated().sorted { $0.element > $1.element }.prefix(8)
for (i, n) in ranked where n > 0 {
    let rows = min(16, h - i * 16)
    print(String(format: "  y %4d–%4d  %5.1f%%", i * 16, i * 16 + rows - 1,
                 Double(n) / Double(rows * w) * 100))
}
if differing == 0 { print("  (none)") }

if args.count >= 4, let png = out.representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: args[3]))
    print("heat map → \(args[3])")
}
// Never fails the build on a difference: what counts as too much is the reader's
// call, and a script that exits 1 on one stray pixel just gets `|| true`'d.
exit(0)
