import AppKit

// Reads pixels out of a screenshot, because eyes cannot.
//
//     apps/ios/tools/pixel-probe.sh <png> [column-fraction] [step]
//
// Round 3 lost an afternoon to a screen that LOOKED slightly soft and was in
// fact washed to about 15% contrast by iOS 26's scroll edge effect: six UI
// assertions passed, the accessibility tree was complete, and only the numbers
// said so — background 252 where the contract says 255, the darkest bubble 215
// where it says 10. Turning the effect off put both back exactly, and hitting
// the constant exactly is what "fixed" means.
//
// A vertical scan rather than a named point: a scan finds the bands itself, so
// nothing here has to know how tall a status bar is on this simulator. Runs of
// identical colour are collapsed, so a whole screen prints as a dozen lines.
//
// NOT `sips --cropOffset`, which is measured from the image CENTRE and will
// quietly sample somewhere else — two wrong conclusions were drawn from it
// before that was noticed.

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write(Data("usage: pixel-probe <png> [column-fraction] [step]\n".utf8))
    exit(2)
}
let fraction = args.count > 2 ? Double(args[2]) ?? 0.5 : 0.5
let step = args.count > 3 ? Int(args[3]) ?? 1 : 1

guard let image = NSImage(contentsOfFile: args[1]),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff) else {
    FileHandle.standardError.write(Data("pixel-probe: cannot read \(args[1])\n".utf8))
    exit(1)
}

let w = bitmap.pixelsWide, h = bitmap.pixelsHigh
let x = min(w - 1, max(0, Int(Double(w) * fraction)))
print("\(args[1])  \(w)×\(h)  column x=\(x) (\(fraction))")

func rgb(_ y: Int) -> (Int, Int, Int) {
    guard let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { return (-1, -1, -1) }
    return (Int((c.redComponent * 255).rounded()),
            Int((c.greenComponent * 255).rounded()),
            Int((c.blueComponent * 255).rounded()))
}

var runStart = 0
var current = rgb(0)
func flush(_ end: Int) {
    let (r, g, b) = current
    // Points as well as pixels: every metric in the port is in points, and a
    // band reported only in device pixels has to be divided by hand every time.
    let scale = h > 2000 ? 3.0 : 2.0
    print(String(format: "y %5d–%-5d  (%6.1f–%-6.1fpt)  rgb %3d %3d %3d",
                 runStart, end, Double(runStart) / scale, Double(end) / scale, r, g, b))
}
var y = step
while y < h {
    let c = rgb(y)
    if c != current {
        flush(y - step)
        runStart = y
        current = c
    }
    y += step
}
flush(h - 1)
