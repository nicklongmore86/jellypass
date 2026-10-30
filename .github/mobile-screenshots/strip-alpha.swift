// Rewrites each PNG named on the command line in place without an alpha channel, which App Store Connect refuses.
// simctl's screenshots are RGBA but fully opaque, so drawing them onto an opaque RGB context changes no pixel.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

for path in CommandLine.arguments.dropFirst() {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let source = CGImageSourceCreateWithURL(url, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
    let context = CGContext(
      data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
      space: image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else {
    FileHandle.standardError.write("Can't read \(path)\n".data(using: .utf8)!)
    exit(1)
  }
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  guard let opaque = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)
  else {
    FileHandle.standardError.write("Can't write \(path)\n".data(using: .utf8)!)
    exit(1)
  }
  CGImageDestinationAddImage(destination, opaque, nil)
  if !CGImageDestinationFinalize(destination) {
    FileHandle.standardError.write("Can't write \(path)\n".data(using: .utf8)!)
    exit(1)
  }
}
