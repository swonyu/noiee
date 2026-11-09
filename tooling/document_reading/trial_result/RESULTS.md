# Measured model-free Docling trial

2026-11-09. This is an **executed isolated synthetic experiment**, following the reviewed [pre-install plan](../runtime_plan/PLAN.md). It does not enable document reading in Noiee or qualify arbitrary user documents. LM Studio remained off; no model server, account, credential, UI or application-store work occurred.

## Results

All eight conversions returned Docling `success` under OS network denial:

- **Native PDF memo:** all expected text recovered; three text items carry page-one bounding boxes.
- **Native PDF table:** all nine text cells recovered, matching PDFKit's token sequence; **zero semantic tables**, as expected for this model-free pipeline.
- **Native PDF columns:** four text items retained, but order was LEFT FIRST, RIGHT FIRST, LEFT SECOND, RIGHT SECOND. It did **not** fix the PDFKit baseline's interleaved reading order.
- **Image-only and blank PDFs:** no text and zero tables. `success` here means conversion finished, not that the document was read. **No OCR was performed.**
- **DOCX, PPTX and XLSX:** each authored fixture produced one 3×3 table with all nine expected cell strings at the exact row/column coordinates: 27/27 observed cells across three fixtures. Word memo and slide title text were also retained. DOCX has no reported page count; no page citations were invented.

The five PDF inputs are byte-for-byte copies of the native PDFKit baseline's authored fixtures, verified against that baseline receipt before the job. All five match its extracted token sequence. The baseline source/fixture generation remains in `tooling/document_baseline` on the integration branch; Neither experiment invokes the installed app or user stores. The three Office fixtures were generated inside the job from explicit synthetic strings and a known 3×3 cell matrix. They contain no macros, external references or user content. Their exact hashes and sizes are in `receipt.json`; their generation source is `research/trial_child.py`.

## Staging and environment actually observed

- Exactly 51 reviewed official PyPI wheels were downloaded: **70,944,225 bytes**, every file size and SHA-256 verified before installation. Staging completed in 6.2561s under the 120s/80MiB limits.
- A separate Python 3.14.8 venv was created in an exclusively owned scratch job, without global package installation or settings changes. Installation used only the verified local wheelhouse with no index, no dependency resolution, hash requirements and binary-only packages. Installation itself also ran with networking denied.
- Metadata inspection confirms the exact 51 planned distributions plus **pip 26.2.1**, the venv's bootstrap installer. No torch, RapidOCR, ONNX Runtime, OCR/layout/table weights or additional packages were installed. The private HOME/cache directories contained no files at the end of the measured pass.
- The actual sandbox probe received EPERM for both loopback bind and a connect attempt to the reserved documentation address 192.0.2.1. It did not contact any local model-server endpoint. The same network-denial profile wrapped imports and each conversion.
- Actual DocumentConverter/NativePdfPipeline imports passed. Cold import took 17.6951s and sampled about 202MiB RSS. Individual fresh-process conversions took **1.1142–1.5503s**, with sampled group RSS **183,713,792–190,283,776 bytes** (about 175–181MiB). These include Python/import startup; they are single-run observations, not a performance distribution or an app-level comparison.
- Peak sampled scratch footprint was **343,755,885 bytes** (about 328MiB), below 1GiB. No wall/output/RSS/disk bound fired. Sampling is not a kernel-enforced quota and may miss brief peaks.

All source inputs, outputs and measurements are synthetic. The retained job includes the local venv/wheelhouse for independent review, but **no executable package payload, venv, wheel, compiled parser or model file is included in this commit**.

## Exact conversion setup

PDF uses `NativePdfFormatOption` / `NativePdfPipeline`, with 45s pipeline timeout, remote services and external plugins disabled, page and picture image generation disabled. `DocumentConverter` allowlists PDF/DOCX/PPTX/XLSX; Office formats use their model-free SimplePipeline backends. Every selected file is at most 1MiB; conversion admission uses at most 5 PDF pages and 1MiB. One job runs at a time with OMP/OpenBLAS thread counts 2.

The process supervisor applies 60s wall time, 1MiB combined stdout/stderr and 2GiB sampled process-group RSS. Scratch is monitored at 1GiB. Abort/cancellation terminates the isolated process group and reaps the parent. These mechanisms were tested using actual authored child processes; an active Docling parse was **not** separately cancelled in this pass. Bounds on malicious decompression, hostile documents, native crash containment and races under load remain unqualified.

Network isolation uses `sandbox-exec` with `(deny network*)`. This profile allows filesystem reads by default. It is **not** a private-file read sandbox. The runner used only allowlisted authored job fixtures and a private HOME/cache; no assertion is made that an adversarial parser/plugin could not read other files. A production helper needs stronger file-access boundaries, input validation and structured locators before user-document use.

## Evidence and reproduction

- `verified-wheels.json`: actual downloaded-byte hashes and sizes, not merely registry declarations.
- `installed-packages.json`: actual isolated-environment distribution versions.
- `network-probe.json`: actual sandbox denial observations.
- `receipt.json`: original step statuses, timings, sampled RSS, stdout hashes, fixture identities and baseline text. It contains no host-private paths.
- `observations.json`: exact decoded conversion output and deterministic baseline/table comparisons. Each observation reserializes to its original recorded stdout SHA-256; no lossy output transformation was used.
- `manifest.json`: hashes of result evidence and the exact supporting source files. It contains no package payloads.

Explicit reproduction, only for a newly authorized scratch experiment:

```sh
python3 -B tooling/document_reading/research/run_trial.py <authored-native-baseline-artifact-directory>
python3 -B tooling/document_reading/research/continue_trial.py <new-owned-job-directory>
python3 -B tooling/document_reading/research/analyze_trial.py <new-owned-job-directory>
```

The first command stages/installs the fixed plan and stops at the real import gate. It does not retry or add missing packages. The second continues only after all gates pass, creates synthetic Office inputs and converts the fixed fixture names; a conversion failure stops the pass without an alternate parser. Generated Office/PDF container timestamps may change byte hashes on reproduction; every run records its actual inputs, while expected strings/cell coordinates stay explicit.

Offline checks: **49 tests pass** on Python 3.15.2 and the exact existing Python 3.14.8, covering reader/staging guards, real child-process supervision, plan/provenance consistency and retained measured results. Tests do not redownload, reinstall or rerun Docling. New source/evidence delta passes `git diff --check`; earlier preserved raw inspection-log whitespace remains historical and unchanged.

## Decision

The minimal Docling installation is feasible on this Mac and added **measured Office table extraction** without model weights. For these simple PDFs it did not improve text order or recover semantic tables/OCR beyond the native baseline, while adding Python/package/startup cost. Keep native PDF text as the smaller baseline and treat this optional Office helper as a justified next candidate, not a shipping capability. OCR and learned PDF table/layout comparison remain separate work requiring their own artifact setup and benchmarks. No automatic download or integration is enabled by this experiment.
