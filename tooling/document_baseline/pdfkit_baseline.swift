// Synthetic-document experiment only. Never called by the Noiee app.
import Foundation
import PDFKit
import CoreText
import CoreGraphics

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(2)
}
func drawText(_ context: CGContext, _ text: String, _ x: CGFloat, _ y: CGFloat) {
    context.textPosition = CGPoint(x: x, y: y)
    let font = CTFontCreateWithName("Helvetica" as CFString, 16, nil)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
    CTLineDraw(line, context)
}
let args = CommandLine.arguments
if args.count != 3 { fail("Usage: baseline generate DIRECTORY | extract FILE") }
if args[1] == "generate" {
    let directory = URL(fileURLWithPath: args[2], isDirectory: true)
    var box = CGRect(x: 0, y: 0, width: 612, height: 792)
    for mode in ["text", "table", "columns", "image", "blank"] {
        let target = directory.appendingPathComponent(mode + ".pdf")
        guard !FileManager.default.fileExists(atPath: target.path), let context = CGContext(target as CFURL, mediaBox: &box, nil) else { fail("Cannot create fresh fixture") }
        context.beginPDFPage(nil)
        switch mode {
        case "text":
            drawText(context, "Synthetic research memo", 50, 740)
            drawText(context, "Project Cedar ships on 14 November 2026.", 50, 700)
            drawText(context, "Budget: 4200 credits. Owner: Ada Example.", 50, 660)
        case "table":
            // Content stream deliberately row-major; no semantic table tags.
            for (i, row) in [["Item", "Quantity", "Cost"], ["Pencils", "12", "24"], ["Folders", "3", "18"]].enumerated() {
                for (j, cell) in row.enumerated() { drawText(context, cell, CGFloat(50 + j * 170), CGFloat(740 - i * 40)) }
            }
        case "columns":
            // Visually two columns; draw interleaved to expose order assumptions.
            drawText(context, "LEFT FIRST", 50, 740); drawText(context, "RIGHT FIRST", 330, 740)
            drawText(context, "LEFT SECOND", 50, 700); drawText(context, "RIGHT SECOND", 330, 700)
        case "image":
            guard let bitmap = CGContext(data: nil, width: 600, height: 200, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("Bitmap failed") }
            bitmap.setFillColor(CGColor(gray: 1, alpha: 1)); bitmap.fill(CGRect(x: 0, y: 0, width: 600, height: 200))
            bitmap.setFillColor(CGColor(gray: 0, alpha: 1)); drawText(bitmap, "SCANNED SYNTHETIC INVOICE 314", 20, 100)
            guard let image = bitmap.makeImage() else { fail("Image failed") }
            context.draw(image, in: CGRect(x: 50, y: 500, width: 500, height: 166))
        default: break
        }
        context.endPDFPage(); context.closePDF()
    }
} else if args[1] == "extract" {
    let url = URL(fileURLWithPath: args[2])
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue <= 1_048_576 else { fail("Input exceeds 1 MiB") }
    guard let doc = PDFDocument(url: url) else { fail("Invalid PDF") }
    guard !doc.isLocked, doc.pageCount <= 8 else { fail("Locked PDF or page cap exceeded") }
    var pages: [[String: Any]] = []
    var total = 0
    for index in 0..<doc.pageCount {
        let text = doc.page(at: index)?.string ?? ""
        total += text.utf8.count
        guard total <= 65_536 else { fail("Output cap exceeded") }
        pages.append(["page": index + 1, "text": text])
    }
    let output: [String: Any] = ["page_count": doc.pageCount, "pages": pages, "ocr_performed": false, "semantic_tables": false]
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} else { fail("Unknown command") }
