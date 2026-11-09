# Local document retrieval experiment

Development-only, offline and standard-library-only. This is **not connected to the app or a model**, and does not enable document ingestion, filesystem access, embeddings or background indexing. No private documents, app stores, installed app, model endpoints or network were used. No packages were installed.

## Existing source boundary

Inspected base: `6cda13010f5f11493c4e890ae91eecae4327af85`.

- `source/Tools.swift`, `RoutineReadPolicy.kind` and the `addFilesystem` configuration path, identify the bundled MCP filesystem provider and the explicitly selected folder. `source/package-lock.json` pins `@modelcontextprotocol/server-filesystem` 1.0.0. This experiment does not alter that provider or its authorization policy and does not benchmark its filename search implementation.
- `source/attachments.js`, `normalize` and `content`, currently accept text, PNG and JPEG. Text attachments have aggregate 12,000-character / 64,000-byte limits. This experiment's independent corpus limits are not app limits.
- No owned document-content retrieval index was found in the inspected app sources. This is a new, isolated feasibility prototype, not a performance claim about the existing app.

## Reproduce

From the repository root, with an existing Python 3 interpreter that provides SQLite FTS5:

```sh
python3 -B -m unittest discover -s tooling/retrieval_lab -p 'test_*.py' -v
python3 -B tooling/retrieval_lab/benchmark.py --output /tmp/noiee-retrieval-$(uuidgen).json
```

The output is created exclusively: an existing receipt is never overwritten. FTS5 absence fails explicitly instead of silently substituting another backend. The script has no input-directory argument and only uses the authored fixture module. It reads its source files and selected app source files for provenance hashes, not user documents. It invokes only `git rev-parse HEAD` for checkout identity.

`receipt-2026-11-09.json` contains actual per-query returned IDs, scores, literal quotes, source offsets, document SHA-256, fixed corpus/query hashes, environment, source hashes and timings. Its Git HEAD identifies the inspected base; source hashes identify the then-uncommitted experimental implementation. `test-receipt-2026-11-09.json` separately captures a fresh test execution and its source hashes. Neither is an app/release qualification receipt.

## Method

- Frozen authored corpus: 18 synthetic documents, including similar products, repeated-keyword distraction, cancellation text, a plain-text table, accented French, Arabic, old/current plans, and untrusted instruction-like text.
- Frozen labels: 21 queries, 17 with one or more relevant document IDs and four with no relevant document. They are **development examples authored alongside this prototype, not a held-out or representative production evaluation**.
- Sizes 18, 256 and 2,048 add deterministic short catalog distractors, not independent relevance judgments. Larger sizes measure scaling against easy distractors, not more realistic quality.
- Baseline: sum of raw query-term frequencies across each document (OR semantics), descending, stable input order on ties. It deliberately provides a simple lexical floor and is vulnerable to repeated terms; it is not a strong TF-IDF baseline or the existing app's search.
- FTS5: built-in BM25, OR over safely quoted normalized tokens, stable row ID on ties. Both methods receive identical case-folded Unicode word tokens, no stemming, stop-word removal or semantic expansion. FTS5 additionally uses `unicode61` token boundaries; complex-script equivalence beyond the included examples is untested.
- Macro Recall@3 averages retrieved relevant IDs / all relevant IDs across positive queries. MRR@3 averages reciprocal first relevant rank, with zero when absent. Negative abstention is the fraction of the four no-answer queries returning no hits, separate from positive metrics. This is not a confidence-calibrated abstention policy.
- One untimed warm query per example, then 30 timed repetitions (630 samples/backend/size). Times include quote production but exclude index construction. Empty and punctuation queries are included. No cold-start, concurrent, disk, extraction or end-to-end model latency measured.

## Observed results

One recorded run on Darwin 27.3.0 arm64, Python 3.15.2, SQLite 3.54.1:

| Corpus | Method | Recall@3 | MRR@3 | Negative abstention | Warm p50 ms | Warm p95 ms | Build ms* |
|---|---|---:|---:|---:|---:|---:|---:|
| 18 | Overlap | 0.9412 | 0.8824 | 0.7500 | 0.0116 | 0.0293 | 0.539 |
| 18 | FTS5 BM25 | 0.9412 | 0.9412 | 0.7500 | 0.0140 | 0.0350 | 0.904 |
| 256 | Overlap | 0.9412 | 0.8824 | 0.7500 | 0.0830 | 0.1468 | 3.083 |
| 256 | FTS5 BM25 | 0.9412 | 0.9412 | 0.7500 | 0.0165 | 0.0400 | 5.660 |
| 2,048 | Overlap | 0.9412 | 0.8824 | 0.7500 | 0.6417 | 0.8400 | 25.086 |
| 2,048 | FTS5 BM25 | 0.9412 | 0.9412 | 0.7500 | 0.0147 | 0.0450 | 40.949 |

*Build times include `tracemalloc` instrumentation; do not compare directly with uninstrumented production timings. An independent rerun retained the same quality results; timings vary with machine load.

The largest corpus is only 224,999 UTF-8 bytes. Largest Python build allocation peaks: overlap 2,876,540 bytes, FTS5 2,888,654 bytes. SQLite page allocation: 409,600 bytes at 2,048 documents. The entire benchmark process peaked at 34,996,224 resident bytes. These are different measurements, not additive or per-backend RSS: Python tracing excludes SQLite native allocations, page count excludes native overhead, and process RSS is the high-water mark across all runs. The FTS prototype retains baseline token counters too for implementation simplicity. No memory-size extrapolation to the 8 MiB cap is justified.

### Failure analysis

- BM25 fixes two first-place ranking mistakes caused by a document repeating `return policy`. Both methods already found those correct documents within their top three; thus MRR improves while Recall@3 does not.
- Both completely miss `dining allowance ceiling`, whose relevant document says `meal reimbursement cap`. This is a concrete lexical/semantic gap, not evidence that a particular embedding model solves it.
- Both return hits for `Atlas telescope warranty lifetime` even though the corpus has no warranty answer. Zero-hit abstention works for unrelated words and empty input but fails for plausible overlapping vocabulary. Do not answer from a retrieved hit merely because it exists.
- All returned quotes match exact source slices and all hashes match their synthetic document snapshots. This proves provenance integrity, **not that a quote supports an answer**, a model will cite correctly, or current versus historical sources will always rank correctly.
- Instruction-like document text is returned as data and never executed. Model prompt-injection resistance is not evaluated.

## Bounds and safety contract

The API accepts an explicit in-memory list/tuple of frozen documents; it never traverses paths or dereferences IDs. Maximum 2,048 documents, 32 KiB UTF-8 per document and 8 MiB aggregate; duplicate/invalid IDs and NUL text are rejected. Queries are at most 1 KiB UTF-8 and 32 distinct tokens. Top-k is 1–20; excerpts are at most 320 Unicode code points. No silent truncation of documents, corpus or query terms. Results bind document ID, SHA-256 and exact `[start,end)` code-point offsets. These are neither byte offsets nor PDF page citations.

The tests cover FTS availability, repeatability, citation integrity, accents/Arabic examples, literal query syntax, absent/empty queries, snapshot stability, source changes, bounds, duplicate IDs, known synonym/abstention failures and the observed ranking improvement. There is no persistent index, importer, file-permission enforcement, deletion/update lifecycle, asynchronous cancellation, extraction/OCR, chunk/page mapping, or model connector. An app integration must define and test these rather than treat this prototype as permission to index files. Bounded synchronous work is not a tested Stop implementation.

## Decision

**Continue with local lexical retrieval, using FTS5 BM25 as the next candidate. Do not install sqlite-vec or add embeddings now.** This experiment supports ranking and scaling benefits versus a deliberately simple lexical baseline, but not a production quality claim. FTS5 works here without another dependency; availability in the intended shipping runtime remains to be verified separately.

Before app integration, collect a larger consented or synthetic held-out set with realistic long documents, extraction errors, duplicate versions, missing answers and multilingual queries. Compare stronger lexical baselines, chunking, coverage-aware evidence selection and calibrated no-answer handling. Preserve explicit user-selected corpus scope, provenance and cancellation through any importer. Docling extraction is a separate evaluation, not exercised by these text fixtures.

Only then run an optional local embedding comparison against the same frozen judgments. Require a measured improvement on semantic-gap queries without unacceptable no-answer false positives, latency/memory cost or grounding regression. A vector store such as sqlite-vec does not itself produce embeddings. An embedding model, compatible runtime/API, licence review, vector dimensions, model/version identity, index lifecycle and explicit model-data destination are separate requirements; none are established by Noiee's current chat-model connection or by this experiment.
