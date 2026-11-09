# Native PDF extraction baseline

This development experiment generates five small, single-page synthetic PDFs using CoreGraphics/CoreText, then measures the installed macOS PDFKit extractor. It uses existing Apple frameworks, not new packages, OCR, a local model, private documents or Noiee's running app. It does not add PDF support to Noiee.

Run on an arm64 Mac with Xcode installed:

```
python3 -B -m unittest discover -s tooling/document_baseline -p 'test_*.py'
python3 -B tooling/document_baseline/run.py
```

Each run retains a fresh ignored `.artifacts/native-document-baseline-*` directory with generated inputs, extraction JSON, logs, binary and receipt. Receipts bind source/compiler/binary/input/log SHA-256 values, source commit/status, commands and per-process timings. PDF generation may include changing metadata; fixture byte hashes need not be identical across runs. This is local evidence, not hostile-host attestation.

## Initial measured result

On macOS 27.3 arm64, PDFKit recovered all three expected prose lines and all three row-major table-text lines. It returned the two-column fixture in row order (`LEFT FIRST RIGHT FIRST`, then `LEFT SECOND RIGHT SECOND`), not the declared column-major reading order. Image-only and blank PDFs both produced empty text. Invalid and oversized files were rejected. Four control tests pass, including deadline cancellation and rejecting empty/bag-of-words false positives.

These observations show that plain native extraction is useful for this simple born-digital text but cannot be treated as table semantics, dependable multicolumn reading order or OCR. A table rendered in a different content-stream order, merged cells, fonts, languages or document layouts can behave differently. The five authored fixtures are not a representative held-out evaluation. Timings are single process launches, not a throughput or latency distribution.

`status: measured` means the experiment ran, including negative inputs. It deliberately does not mean all capability observations are true. Check the individual observations. `semantic_tables` and `ocr_performed` are always false, accurately describing this extractor.

## Bounds and limitations

Compilation has a 120-second deadline; each fixture generation/extraction process has a 15-second deadline. Expiration kills the owned process group. Input size is capped at 1 MiB, pages at eight and extracted UTF-8 at 64 KiB. Logs are checked against a 1 MiB aggregate cap after completion, not capped during writes. This is **not a sandbox or a hard memory/disk/network quota**: PDFKit parses before the page cap and allocates text before the output cap. Only these small authored inputs were used. Do not expose the helper to untrusted user files as a production service.

The synthetic bitmap page is sufficient to demonstrate that PDFKit does not OCR images; it does not measure any OCR engine's accuracy. No Office parsing, table reconstruction, no-network enforcement, process-tree adversarial cancellation or native app integration has been qualified. Compare a separately reviewed Docling pipeline on equivalent fixtures before deciding whether its added dependencies and model assets justify deployment.
