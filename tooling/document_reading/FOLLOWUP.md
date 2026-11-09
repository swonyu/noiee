# Exact wheel resolution and artifact licence follow-up

2026-11-09. Supplements, rather than replaces, the initial feasibility report. No converter or ML package was installed/imported, no sdist/build hook was run, and no model weight bytes were downloaded. Public wheel ZIP directories, licence entries and RapidOCR's text registry were read using HTTP ranges, not whole-wheel downloads.

## Measured resolution result

The existing Python 3.14.8 arm64 interpreter's pip 26.2.1 completed a **binary-only, ignore-installed, isolated dry-run against official PyPI** in 20.83 seconds, exit 0. It selected **103 exact wheel artifacts**. This is positive evidence that a wheel-only dependency set resolves on this machine, not just a statement that resolution is pending. No unavailable-wheel or dependency-conflict blocker was found for that environment. This does not test installation, native linking, runtime imports or conversion.

`evidence/resolve-observation.json` records the command and boundary (report destination now normalized to repository-relative form; original observation hash/commit retained). `pip-resolve.log` shows metadata downloads only, no full wheel download. The raw pip report is preserved losslessly as `pip-report.json.gz`; its decompressed SHA-256 is `88d300aa34564a6918d7be92f1a0726381fd9b55a35c98194bacd60a0926c786`. The run had a 180-second deadline and 50MiB monitored temporary-storage threshold, neither reached; the threshold was not a hard total network quota.

`resolved-inventory.json` records all selected package versions, wheel URLs and registry-declared SHA-256 hashes, Python requirements, original metadata labels/classifiers, explicitly normalized short labels and explicit truncation markers/hashes. Those whole-wheel hashes were **not** locally verified because full wheels were not downloaded. Full raw metadata is retained in the compressed report. This exact set supersedes initial `metadata_snapshot.json` latest-version rows. Notable resolver choices: typer 0.27.3 (rather than incompatible latest 0.28.0), huggingface_hub 1.33.0 (rather than latest 2.4.0), RapidOCR 3.10.0, torch 2.15.0, torchvision 0.29.2, transformers 5.22.2. No ONNX Runtime, ocrmac or EasyOCR is selected.

The initial snapshot now includes its root URLs/raw-response hashes and missing python-dotenv Python requirement. `research/summarize_report.py` regenerates the inventory from a raw report. `research/inspect_wheel_notices.py` documents the bounded range reader; it neither extracts executable files nor imports wheel modules. These are explicit research commands, not application/CI startup hooks.

## Licence findings from actual selected wheels

The final merged archive contains 277 notice entries across 103 selected wheels using 3,191,292 range-response bytes. An earlier sequential pass was stopped and repeated in bounded parallel form; its traffic is not included in that figure. Final merged records contain no fetch errors or oversized-notice skips; the retained inspection log covers only the earlier parallel pass, not the targeted repair. See `evidence/evidence-quality.json` for both pass summaries and merge provenance. PyPDFium2’s 37 notices and torch’s 65 notices were successfully inspected after broadening the directory-name match and ZIP-directory read cap.

Historical decoded notice previews and SHA-256 values computed from original bytes are preserved in `evidence/wheel-notices.json.gz`; `wheel-notice-index.json` supplies per-wheel paths, sizes, hashes and explicit errors without large licence bodies. A wheel notice scan is not an exhaustive binary provenance analysis: copied files can lack licence-like names, and licence text can mention components not actually shipped. Do not infer licence obligations from a keyword alone.

Specific material findings:

- **Shapely 2.2.0**: `LICENSE_GEOS` expressly identifies bundled GEOS and LGPLv2.1. Its BSD-3-Clause package label alone is incomplete. Before distributing Noiee with this wheel, preserve LGPL/GEOS notices and establish applicable corresponding-source and user replacement/relinking arrangements for the dynamic library. This is an actionable distribution gate, not evidence that commercial/private use is forbidden.
- **setuptools 84.2.1**: vendored autocommand 2.2.2 licence text is LGPLv3. Do not classify the entire installed environment as MIT merely because setuptools reports MIT. Determine which vendored code would actually ship and satisfy its applicable LGPL requirements, or exclude unneeded distribution components without breaking qualification.
- **NumPy 2.5.4 and SciPy 1.18.1**: wheel notices describe GCC runtime components under GPL-3.0-or-later WITH GCC-exception-3.1. Preserve both notices and exception; assess the actual bundled runtime. This is not plain GPL and does not automatically impose GPL on Noiee.
- **OpenCV headless 5.0.0.93**: wheel includes its wrapper licence plus ~180KB third-party notices twice (package and dist-info). The Apache package label is not the complete redistribution notice set.
- **certifi 2026.10.23 and tqdm 4.70.1** retain MPL obligations represented in package metadata and wheel notices. Treat distribution/source availability separately from local development use.
- Missing metadata labels were narrowed by actual notices: langcodes MIT, safetensors Apache-2.0, tree-sitter MIT, omegaconf BSD-3-Clause plus ANTLR attribution, markdown-it-py/mdurl MIT, Jinja2 BSD-style terms. Refer to retained texts, not a guessed SPDX label.
- The tiny docling wrapper, latex2mathml and tokenizers wheels yielded no licence-named entries. Their metadata/upstream declarations do not vanish, but the distribution must supply the relevant licence/attribution material; lack of a wheel notice is not proof of no permission. The index distinguishes this from a fetch failure.

No finding establishes a prohibition on the proposed isolated private benchmark. None establishes blanket redistribution clearance either. The concrete remaining distribution work is notice/source/relinking compliance for the named bundled components and complete ownership/provenance for model conversions, not an unspecified “all licences unknown.”

## Exact standard OCR route and artifacts

This resolved clean environment has neither ocrmac, ONNX Runtime nor EasyOCR. Under Docling 2.149.0's [auto OCR selection](https://github.com/docling-project/docling/blob/v2.149.0/docling/models/stages/ocr/auto_ocr_model.py), the **expected** available route is RapidOCR with torch. This follows source plus resolved dependencies; execution has not verified it. The default empty language list uses the engine default, which [RapidOCR integration](https://github.com/docling-project/docling/blob/v2.149.0/docling/models/stages/ocr/rapid_ocr_model.py) maps to `ch`, PP-OCRv6 small detection/recognition plus PP-OCRv4 mobile classification.

The pinned [RapidOCR v3.10.0 registry](https://github.com/RapidAI/RapidOCR/blob/bd941dae09da793e76c6ba15c7aaf40f8424232a/python/rapidocr/default_models.yaml), also read from the exact selected wheel, identifies:

- `torch/PP-OCRv6/det/PP-OCRv6_det_small.pth`, SHA-256 `fbdc74c97ea7b770ab22cbdc1bba01a52bdf1975efcf3442057356d622b05d54`.
- `torch/PP-OCRv6/rec/PP-OCRv6_rec_small.pth`, SHA-256 `0107b2ad694ccc9b1db7cf9ed3ffbc93d1795d9e08d9cf823127243a87bce516`.
- `torch/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.pth`, SHA-256 `bfe13860824b3365c0c7f7ccfcddc8ff11645c60051739ff18bc9913f60c98e1`.
- Recognition dictionary: `paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`. No dictionary hash accompanies this registry entry.

Each path is relative to `https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/`. These are registry observations, not downloaded/hash-verified assets.

The exact wheel includes [MODEL_LICENSES.md](https://github.com/RapidAI/RapidOCR/blob/bd941dae09da793e76c6ba15c7aaf40f8424232a/python/MODEL_LICENSES.md). It positively grants Apache-2.0 distribution for **three specifically listed ONNX artifacts**, with separate Baidu/PaddleOCR upstream attribution and conversion notices. Its scope expressly says other artifacts require their own source review. Thus it cannot by itself clear the torch `.pth` conversions or dictionary above. This is the precise missing provenance/permission linkage. No noncommercial restriction was found in the inspected notice; do not invent one.

The notice-covered ONNX files have published hashes:
- `PP-OCRv6_det_small.onnx`: `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f`.
- `PP-OCRv6_rec_small.onnx`: `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884`.
- `ch_ppocr_mobile_v2.0_cls_mobile.onnx`: `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c`.

These are bundled by RapidOCR's default ONNX configuration. Therefore even installing the full RapidOCR wheel entails receiving bundled model assets; the metadata-only dry-run and range inspection deliberately did not fetch those entries. An explicit ONNX backend is a better-documented candidate, but requires a separate resolver/runtime check including onnxruntime and asset hash verification. Do not silently change backend in the app.

## TableFormer licence narrowed, not unknown

Docling's default TableFormer mode is accurate. The source pins [docling-models v2.3.0](https://huggingface.co/docling-project/docling-models/tree/v2.3.0), resolving to `fc0f2d45e2218ea24bce5045f58a389aed16dc23`. Its immutable README explicitly declares **CDLA-Permissive-2.0**. This is affirmative licence evidence covering the model repository, even though no standalone LICENSE file is present. The initial report's attribution gate should not be misread as an absent licence grant.

[CDLA-Permissive-2.0](https://cdla.dev/permissive-2-0/) permits use/modification/sharing under its terms; section 2.1 requires making the agreement text available with shared data, while section 3 does not restrict computational results. Include its text when distributing these model artifacts. No noncommercial limitation or incompatibility with local inference was identified. A current main-card Apache label must not replace this pinned tag's declaration.

The immutable tree identifies default `model_artifacts/tableformer/accurate/tableformer_accurate.safetensors`: 212,758,388 bytes, LFS SHA-256 `2a7d6c924b3cd12fb99a09280ca9c33a89c5d60b93253617d2e088c1a40374d9`, plus 7,060-byte `tm_config.json`. The unused fast model is 145,453,276 bytes with LFS SHA-256 `3119563aab5a7c96fda4d621119b63fd8806272b86c30936d15507616422f718`. No model bytes were downloaded. These sizes are specific artifact metadata, not a total installation-size estimate. Preserve the pinned README and agreement, fetch only selected artifacts in a later approved setup, verify their bytes and record the config hash. Heron layout remains separately Apache-2.0 as recorded in the initial report.

## Smallest next experiment

The current research permits continuing metadata/range inspection of a **minimal docling-slim Office-only set** or a deliberately selected ONNX extra, without installation. This can avoid treating all 103 packages as necessary for every input format. For actual runtime qualification, first stage a separately owned Python3.14 venv with the exact selected wheels and explicit asset manifest; no modification of Fetch's environment. Native PDFKit with authored text PDF fixtures remains the smaller no-new-package baseline.

For a Docling PDF benchmark, select CPU, fixed layout/table artifacts, OCR initially off, no enrichments, private cache, network denial and synthetic files. Then separately enable one documented OCR engine and compare. Installing or fetching assets was outside this follow-up's scope and was not attempted. The helper implementation must still enforce the bounds/cancellation/provenance contract from README; a successful resolver is not conversion support or release acceptance.

## Follow-up checks

Ten diagnostic tests pass on both Python3.15.2 and the exact existing Python3.14.8. New cases cover missing distribution metadata, slim version mismatch, reviewed version boundaries and the actual JSON CLI. The original whole-range `git diff --check` pass claim was incorrect: the raw notice-inspection.log has 102 trailing-whitespace lines, intentionally preserved. gzip losslessly preserves the report/notice JSON, but one historical FreeType notice preview used replacement decoding and does not preserve its original bytes; its original-byte hash cannot be regenerated from the preview. See `evidence/evidence-quality.json`. Manifest hashes cover their stored bytes and research scripts. No conversion, runtime install, UI or app qualification was performed.

## Evidence and reader correction

The previous evidence files are not silently normalized: historical archives and raw logs remain byte-identical. The quality sidecar identifies the FreeType preview limitation and documents the earlier parallel pass versus targeted repaired pass. There is no claim that the historic HTTP responses passed the newly added validation. The report destination is normalized in the observation with its prior hash/commit retained.

The research reader now validates HTTPS, host, port, credentials and wheel path before requests and redirects, checks final response URLs, requires exact Content-Range start/end/total and Content-Length, rejects encoded or wrong-sized bodies, and enforces the 1MiB decompressed cap on the RapidOCR registry as well as notices. Future notice records retain raw base64 alongside explicitly labeled previews. These changes are verified with 26 offline tests, including malicious redirects, malformed/mismatched ranges, incorrect bodies and oversized registry metadata. No network rerun, conversion, package execution or inference was performed for this correction.
