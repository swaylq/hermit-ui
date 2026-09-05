import AppKit

// Take a w×h rectangle out of a PNG, from an origin measured at the TOP-LEFT.
//
//     png-crop <in.png> <out.png> <width> <height> [x] [y]
//
// This exists because `sips --cropOffset` is measured from the image CENTRE, not
// from its top-left — a trap `pixel-probe.swift` already carries a warning
// about, and one that cost this round an hour: a headless-Chrome screenshot
// cropped "to the top" with sips came out shifted 130 pixels and every element
// in the comparison read as 43 points out of place.
//
// Used by tools/render-web-hold.sh: headless Chrome captures the WINDOW, and the
// window has to be taller than the phone for `vh` to mean the right thing (see
// the viewport note there), so the reserve has to come back off the bottom.

let args = CommandLine.arguments
guard args.count >= 5, let w = Int(args[3]), let h = Int(args[4]) else {
    FileHandle.standardError.write(Data("usage: png-crop <in.png> <out.png> <width> <height> [x] [y]\n".utf8))
    exit(2)
}
let x = args.count > 5 ? Int(args[5]) ?? 0 : 0
let y = args.count > 6 ? Int(args[6]) ?? 0 : 0
guard let src = NSImage(contentsOfFile: args[1]),
      let tiff = src.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cg = bitmap.cgImage else {
    FileHandle.standardError.write(Data("png-crop: cannot read \(args[1])\n".utf8))
    exit(1)
}
guard x + w <= cg.width, y + h <= cg.height else {
    FileHandle.standardError.write(Data("png-crop: \(w)×\(h) at \(x),\(y) does not fit in \(cg.width)×\(cg.height)\n".utf8))
    exit(1)
}
// CGImage's origin is top-left, which is the whole point of using it here.
guard let cut = cg.cropping(to: CGRect(x: x, y: y, width: w, height: h)),
      let png = NSBitmapImageRep(cgImage: cut).representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("png-crop: cannot crop\n".utf8))
    exit(1)
}
try? png.write(to: URL(fileURLWithPath: args[2]))
