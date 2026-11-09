# Local document reading evaluation

Reviewed 2026-11-09 against Noiee base `6cda13010f5f11493c4e890ae91eecae4327af85` and Docling `v2.149.0`.

**Follow-up:** [Exact wheel resolution and artifact licences](FOLLOWUP.md) now records a successful 103-wheel binary-only resolution, actual wheel notices and specific remaining model/distribution obligations. Initial unresolved-resolution statements below are historical.

## Decision

Keep Docling **optional and out of the shipped app** pending an isolated real-parser benchmark and a resolved dependency/model licence audit. It offers a plausible capability beyond current text/image input, especially PDF reading order, tables and OCR. This work does not add PDF/Office support, install packages, fetch model weights, access user documents, or connect to a model server. Only public source/metadata was fetched. No converter stub or synthetic test is counted as a successful document conversion.

Deliverables are this decision and integration contract, a direct-dependency metadata snapshot, and a no-download/no-import diagnostic with six synthetic metadata tests. The snapshot is not an installation lock, complete SBOM, or legal clearance.

## Existing boundary

`source/attachments.js` accepts text, PNG and JPEG snapshots only, never file paths or access grants. It limits a message to four attachments, text to 12,000 JavaScript UTF-16 code units and 64,000 UTF-8 bytes combined, images to 2 MiB combined, dimensions to 4096 per side and 16 million pixels. Request-history images are limited to nine and 8 MiB. Coding text plus attachments is limited to 20,000 code units. `source/app.js` exposes the text limit. Existing validation does not parse PDF, DOCX, PPTX or XLSX. A filename ending in `.pdf` must never bypass this boundary.

Document conversion must produce a new, explicitly reviewed result before attachment/retrieval admission. Do not add PDF bytes to `kind: text`, relax the limits, silently truncate, or imply that an OCR observation is the original source.

## Current release and dependency findings

Live [PyPI Docling metadata](https://pypi.org/pypi/docling/2.149.0/json) identifies 2.149.0. Search indexes still returned older versions, so the live release metadata and [tagged source](https://github.com/docling-project/docling/tree/v2.149.0) are the reference, not those snippets.

The [root pyproject](https://github.com/docling-project/docling/blob/v2.149.0/pyproject.toml) now builds **docling-slim**, while [packages/docling](https://github.com/docling-project/docling/blob/v2.149.0/packages/docling/pyproject.toml) is the standard wrapper. `docling==2.149.0` requires `docling-slim[standard]==2.149.0`. The slim base has nine direct dependencies; standard adds PDF, Office, local model, OCR, CLI, web/email and other features. Do not use an old monolithic install recipe or assume slim alone converts PDFs.

`metadata_snapshot.json` preserves exact advertised base/standard requirement strings and public licence metadata for each named direct package as observed. Version rows are latest metadata observations, **not a resolver output**. For example, observed latest typer 0.28.0 violates Docling's `<0.28.0` constraint. Optional `docling-core[chunking]`, Python/platform markers and all transitive dependencies still need resolution. An install-ready lock must include hashes and actual arm64 wheels. Avoid source builds in initial qualification.

Material dependencies include torch/torchvision, scipy/numpy, Pillow, docling-parse, pypdfium2/PDFium, docling-ibm-models, Hugging Face hub, RapidOCR, python-docx, python-pptx and openpyxl. The metadata contains MIT, Apache, BSD and other notices, including MPL-2.0 for certifi and MPL-2.0 AND MIT for tqdm. Torch and NumPy report composite expressions for bundled code; pypdfium2 explicitly references dependency licences. Some rows are absent or non-SPDX (langcodes, scipy, torchvision). **MIT on Docling does not clear the shipped dependency bundle.** Inspect actual wheel licence files, native libraries (including PDFium and spatial-index dependencies), notices and transitive packages before distribution. This report is engineering due diligence, not a legal opinion.

For a narrower experiment, evaluate selected slim extras (`convert-core`, `format-docx`, `format-pptx`, `format-xlsx`) separately from the standard PDF/ML stack. This is a candidate dependency reduction, not a validated compatible runtime.

## Python and macOS

Tagged package metadata requires Python `>=3.10,<4.0`, advertises Python 3.10–3.14 and macOS. [Installation guidance](https://docling-project.github.io/docling/getting_started/installation/) distinguishes Apple Silicon from Intel; Intel requires special PyTorch/NumPy compatibility handling. Do not extrapolate an arm64 result to Intel.

Observed here: arm64; default `python3` is 3.15.2. The existing Fetch contract points to `/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/bin/python3.14`, which was read-only checked and reports 3.14.8. Both interpreters have no installed Docling/docling-slim distribution. Python availability is therefore **not** the blocker: a separately owned 3.14 virtual environment is a plausible next experiment. Do not modify Fetch's qualified interpreter, environment or runtime contract. Exact selected wheels, ABI compatibility and converter runtime remain unverified. No install/size/speed/RAM claims are made.

## Model licences and network behavior

Sources: [pipeline options](https://github.com/docling-project/docling/blob/v2.149.0/docling/datamodel/pipeline_options.py), [model downloader](https://github.com/docling-project/docling/blob/v2.149.0/docling/utils/model_downloader.py), [advanced options](https://github.com/docling-project/docling/blob/v2.149.0/docs/usage/advanced_options.md).

- PDF defaults enable OCR and table structure. Remote services and external plugins default off. `artifacts_path=None` still allows first-use model fetching. **Remote-services-off is not a network sandbox.** Document timeout defaults to None; documented timeout behavior can return partial success.
- The downloader's default set includes layout, TableFormer, code/formula, picture classifier and RapidOCR. That is broader than the minimum proposed pipeline. Do not run generic model prefetch or `--all` for this experiment.
- [Heron model card](https://huggingface.co/docling-project/docling-layout-heron) identifies Apache-2.0, currently identifies Heron as default layout, and reports 42.9M parameters. Observed repository revision `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8`. Pin the exact chosen files and preserve applicable notices; no weights were downloaded or checked.
- [Table structure source](https://github.com/docling-project/docling/blob/v2.149.0/docling/models/stages/table_structure/table_structure_model.py) downloads `docling-project/docling-models` at `v2.3.0`. The [tag-specific model metadata](https://huggingface.co/api/models/docling-project/docling-models/revision/v2.3.0) resolves to `fc0f2d45e2218ea24bce5045f58a389aed16dc23` and declares CDLA-Permissive-2.0. The current main card has both CDLA-Permissive-2.0 and Apache-2.0 labels. Do not replace the tag's terms with the current card's labels. The inspected file listing supplied no standalone LICENSE file; exact artifact-level attribution/terms must be established before redistributing the selected files.
- [Auto OCR source](https://github.com/docling-project/docling/blob/v2.149.0/docling/models/stages/ocr/auto_ocr_model.py) attempts ocrmac first on macOS, then alternatives depending on installation/language. Select an engine explicitly for reproducibility. [RapidOCR integration](https://github.com/docling-project/docling/blob/v2.149.0/docling/models/stages/ocr/rapid_ocr_model.py) resolves checkpoints and associated files separately and can download missing models. RapidOCR package metadata says Apache-2.0, but this does **not** prove the exact selected OCR weights/dictionaries have identical terms. Their inventory/licences remain a gate.
- ocrmac/Apple Vision is worth testing to avoid a separate OCR weight set, but its wrapper/transitive package licences, macOS language availability, accuracy and offline behavior have not been audited here. Do not claim that layout/table weights disappear when using native OCR. No VLM, ASR, enrichment, remote serving or external plugin is needed initially.

## Proposed helper contract (not implemented)

Use a separately qualified, versioned subprocess, never import Docling into the main backend or let models supply command arguments/paths. Native selection grants one file; copy bounded bytes to an exclusive private job directory and close the original access scope. Reject URLs, directories, symlinks, special files, unsupported/encrypted inputs and archive traversal. Allowlist PDF/DOCX/PPTX/XLSX only after signature/container validation; block macros and external relationships. No file lookup from document text.

Initial qualification targets, not proven limits: 10 MiB input, 50 PDF pages, 50 MiB total expanded Office data, 2,000 archive members, 20 MiB per member, 100:1 decompression ratio, 16M decoded pixels per image, 120-second wall deadline, two CPU threads and one job at a time. All limits must be checked during processing, not merely after allocating output. Bound stdout/stderr while streaming; use 1 MiB maximum structured result and 1,000 segments. Actual hard memory enforcement on macOS requires separate design/testing; a Python setting alone is insufficient. Stop must terminate the child process group, escalate to kill after a short grace period, discard pending results, and prevent a late completion from repopulating a cancelled/replaced attachment. Temporary files need explicit cleanup with no history/store deletion.

Disable network at the process/container boundary, use a minimal environment and private caches, explicitly set remote services/plugins/enrichments off, supply reviewed local artifacts and offline hub settings. Offline environment variables alone do not block arbitrary HTTP. Qualification must prove cold-cache failure is immediate and does not download, and prove no remote Office relationships or document URLs are fetched. Keep parser output inert: it cannot grant tool authority, credentials or permission to follow instructions embedded in a document.

Result proposal:
- schema version, job ID, source SHA-256 and byte length, display filename (no absolute path), parser/version, options and model-manifest digest;
- outcome `complete`, `partial`, `cancelled`, `failed`, or `unsupported`; warnings and explicit truncation reasons;
- ordered segments: stable ID, plain text, kind, and locators (PDF page plus bounding box where available; Office sheet/cell, slide or section). Do not invent PDF page locators for flowing DOCX text;
- tables as bounded cell data with row/column spans and source locators, not screenshots represented as extracted text;
- confidence/OCR provenance when supplied, elapsed time and measured resource observation.

Only complete/reviewed excerpts enter the current text attachment limit. Partial or timed-out output requires visible labeling and deliberate selection. A retrieval index should use source hash + segment ID + locators, retain parser provenance, and reject stale/deleted sources; it must not ingest the whole filesystem. No retrieval-worker dependency is introduced by this research-only deliverable.

## Alternatives and next experiment

1. **PDFKit + Vision:** already platform-provided APIs, avoids a Python/ML distribution for simple embedded PDF text and native OCR. PDFKit alone does not establish complex table recovery or reading order. Need authored PDF/text/scan fixtures, orientation/Arabic/English coverage, cancellation and limits. No PDFKit extraction was run in this change.
2. **Bounded ZIP/XML Office reader:** can extract DOCX paragraphs, PPTX slide text and XLSX cell content without ML. It still must handle shared strings, relationships, merged cells, hidden content, formula cached values and ZIP/XML bombs. Never execute macros or recalculate formulas. It is not equivalent to rendered layout, Office pagination or OCR. No Office parser was implemented here.
3. **Docling standard:** benchmark only after a hashed dependency/model manifest is approved. Use a dedicated venv and private test cache. Measure text recall, table-cell exactness, reading-order errors, locator correctness, OCR character error rate, latency, peak RSS and cancellation on identical synthetic documents against the native/minimal baseline. Include corrupted/encrypted/oversized files, missing artifacts and forced timeout. Report each real-parser failure; do not substitute an injected parser pass.

Start with an authored born-digital one-page PDF, a two-column/table PDF, an image-only scan, and small DOCX/PPTX/XLSX fixtures with known text/cells. Include multilingual fixtures before choosing OCR languages. Choose Docling only if measured capability gains justify its resource/distribution cost. Neither embeddings nor Noiee's model connection are prerequisites for conversion.

## Verification

Run from repository root:

```sh
python3 -B -m unittest discover -s tooling/document_reading -p 'test_*.py' -v
python3 -B tooling/document_reading/preflight.py
```

Executed: six synthetic metadata tests pass on both Python 3.15.2 and 3.14.8; diagnostics run on 3.15.2 and the exact existing 3.14.8 executable. Both correctly report missing packages and `conversion_verified: false`, `production_ready: false`. The diagnostic exits normally even when not ready; consume its JSON fields, not exit status, as evidence. No package imports, install, model downloads, real conversion, performance benchmarks, full app qualification or UI acceptance were executed. Those are pending prerequisites, not denied actions.
