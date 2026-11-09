# Noiee exact-model improvement lab

Date: 2026-11-09. Noiee was previously named Saleh Uncensored.

## What is implemented

- Preserve validated streamed token usage in `source/agent-stream.mjs`; seven focused usage checks supplement the existing stream checks. Callers still need to persist and present this telemetry.
- Defer whole-chat serialization until the existing save boundary while incrementing the edit revision immediately. Ten focused persistence tests preserve leave, save, and structural-transaction race checks.
- A frozen eight-case, standard-library local benchmark with read-only mock tools and a bounded AST evaluator. It never executes model-produced code on the host.
- Explicit app-prompt, sampling-profile, and JSON-schema comparison controls with immutable per-run receipts.

These changes belong to the isolated `model-lab/20261109` branch based on `e7a2f102ecbaf9dff0ff40b2e5ebe8bfae654523`. They have not been merged into the original branch or installed as an application release.

## Verified model and runtime

Model key: `qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp`.

Publisher: `HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF`, revision `993a5971fda8f30dd1b7eb2654792ba4415c7460`.

Text artifact: `Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf`, 31,457,990,784 bytes.

SHA256: `4e7735df4d1e2ec721f2551f531b815702a2f89123238c564797eda4b0304bc2`; full local-file hash matches the publisher manifest. The separate vision projector was not evaluated.

Observed hardware: Apple M5 Max, 48 GiB physical memory. LM Studio selected llama.cpp runtime 2.71.0. Flash Attention, q8_0 K/V caches, and embedded MTP were already enabled. They are not newly implemented optimizations.

Normal loading of these same weights at 32,768 context and parallel 1 succeeded without a guardrail override. One synthetic recall request used 23,253 prompt tokens, returned all three markers correctly, and took 51.122 seconds. System swap was already substantial and increased during this request. This is not sustained memory qualification or end-to-end Agent/Tasks acceptance. The temporary model instances were unloaded after testing.

## Evidence and result interpretation

On the frozen eight cases, the app-prompt baseline returned 0 strict passes; the publisher non-thinking sampling profile returned 2; schema-constrained output returned 2 passes and one evaluator-unsupported code response. Formatting errors dominate several baseline failures. These are small synthetic transport checks at 8K, not a score for the entire app or general model intelligence. Read the detailed receipts and the independent diagnostic analysis before comparing profiles. No sampling-profile promotion is supported.

Mac checks passed: existing stream parser checks, seven usage checks, ten draft checks, and 31 harness self-tests. A separate pre-existing compaction fixture failed on both the baseline and candidate Linux snapshots; those failures remain unresolved qualification evidence. Native save/close/reopen and release gates remain outstanding.

Experiment receipts, model metadata, and Python dependency lock live on the Mac at `/Users/saleh/Documents/Noiee/updates/model-lab-20261109`. The supplied evidence bundle contains copies. No fine-tuning, model-weight conversion, or replacement-model download was performed.

## Reproduce the bounded comparison

The benchmark needs an already loaded, exact instance; it does not silently load or substitute a model. Use a fresh output directory on every invocation. The following reproduces the original 8K experiment rather than the separate 32K recall check:

```sh
lms load qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp --context-length 8192 --parallel 1 --ttl 600 --identifier noiee-lab-baseline-20261109
python3 -m unittest discover -s tooling/model_lab/bench -p test_suite.py
python3 tooling/model_lab/bench/run_benchmark.py --model noiee-lab-baseline-20261109 --source-model-id qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp --system-prompt-file tooling/model_lab/bench/app-system-prompt.txt --temperature 0.1 --seed 41 --label baseline --output-dir /absolute/path/to/new-results
lms unload noiee-lab-baseline-20261109
```

Add `--generation-profile tooling/model_lab/bench/publisher-instruct-profile.json` only for that explicitly labeled comparison. Add `--constrained-json` only for the separate non-tool structured-output experiment. A request records sampling parameters, but does not prove the backend honors every field or makes seeded runs deterministic.

## Next implementation gates

1. Qualify actual Agent/Tasks at 32K with memory headroom, disposable projects, cancellation, and reopen behavior.
2. Carry usage into durable run receipts and add exact model/template/runtime provenance.
3. Replace conservative byte accounting with qualified tokenizer/template accounting and preserve the fallback.
4. Build a larger untouched holdout of real Noiee tasks and source-bound acceptance validators.
5. Improve retrieval, tool discovery, and validated structured outputs; use deterministic tools for exact arithmetic.
6. Consider adapter training only after exact trainable lineage, architecture support, and deployment round-trip are demonstrated. An ordinary Qwen MLX checkpoint is a different base, and a GGUF reconstruction is a derivative.

The complete audit and phased roadmap accompany the research report. Estimated future work is not represented as completed implementation.
