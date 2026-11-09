# Agent evaluation, version 1

Date: 2026-11-09. This adds evaluation infrastructure, not a demonstrated model improvement. It leaves the original H01–H08 fixtures and default selection intact. The new A01–A15 set is separately versioned as `noiee-agent-development-1`, with a hash over prompts, schemas, expected answers and tool definitions.

## Reproduce without a model or dependencies

From the checkout root:

```sh
python3 tooling/model_lab/bench/run_offline.py --output-dir .artifacts/agent-evaluation-NEW
```

Use a new empty directory each time. Python's standard library, Git, and the reviewed installed Node runtime are sufficient. This Mac gate pins Node 26.13.0 (Darwin arm64) by binary SHA256 `7296c3dda88793e08d1089d839a782178c4bba6bb22f5c40ab2a75263fb071bd`; `--node /absolute/path/to/node` may select only that reviewed binary. A runtime upgrade or another platform requires reviewing and updating the pin, not bypassing the check. No install is performed. The allowlisted integration checks execute shipped JavaScript against disposable synthetic fixtures, in-memory streams and inert renderer objects. They do not start the application, invoke native/MCP work, access saved user conversations, or contact a model. Some existing checks retain generated temporary fixture directories for inspection.

`results.json` records the checkout HEAD, source hashes (including transitive local source), exact commands, per-group exit statuses/timings, log hashes and an unchanged-source check. An exit code alone is insufficient: the runtime must match the reviewed binary, its canonical executable must remain unchanged, and the log must contain complete exact-count test evidence. Python requires 46 successful unskipped methods; TAP suites require respectively 7, 10, 8 and 26 distinct passing tests with exact plans and zero skips/failures. Lifecycle and budget each require five exact ordered markers and their terminal synthetic receipt. Empty, partial, duplicate, zero-test, skipped and malformed evidence fails. Child processes receive an allowlisted environment without inherited NODE_OPTIONS/NODE_PATH, PYTHON*, DYLD_* or LD_* hooks; Python uses isolated/no-site mode and Node disables addons/global module search. Exact argv, input-file hashes and runtime identities/hashes are recorded. Logs, source and executable hashes are rechecked before the final result. Missing runtimes, exceptions and timeouts remain distinct failures. Source mutation invalidates the run. Logs are the assertion-level evidence; **7/7 groups is not 7 model tasks or a model score**. `model_evaluated` is false and `model_score` is null.

The fixed groups are:

| Group | Actual evidence | Limits |
|---|---|---|
| grader_controls | Legacy and new positive/negative graders; all 15 scripted native-tool/answer traces; receipt, category score and blocked-preflight controls | Scripted correct responses, not model inference |
| stream_stop | Shipped stream reader: pending cleanup, callback interruption, errors and no later chunks/tool calls after Stop | In-memory stream, not inference server interruption |
| agent_lifecycle | Shipped Agent lifecycle: claim/dispatch binding, revoked/stale claims, Stop races, saved receipts and cold read without replay | Mock replies and effects, no native tool execution |
| agent_budget | Shipped Agent loop: action/context boundaries, final review, receipt preservation and unknown late Stop outcome | Synthetic contexts/results, not long-run model competence |
| saved_drafts | Actual persistence functions with controlled timers/storage and real attachment serializer | No installed UI or user storage |
| stop_outcomes | Actual stopped MCP outcome reader/renderer and scoped refresh state | Inert DOM; does not establish remote process termination |
| live_profile_guards | Runtime/profile, exact reply, source/retained receipt identity and root compaction guard rejection cases | No CodingEngine, model or actual compaction run |

These checks supplement, not replace, full release, native, UI, actual MCP shutdown, compaction and loaded-model qualification gates. A historical compaction failure is not erased by a passing offline guard suite.

## Future opt-in model run

Only after the operator has authorized and verified an already loaded exact model instance:

```sh
python3 tooling/model_lab/bench/run_benchmark.py \
  --suite agent --model EXACT_ALREADY_LOADED_INSTANCE \
  --source-model-id VERIFIED_ARTIFACT_OR_unknown \
  --label agent-baseline \
  --output-dir /absolute/path/to/new-model-run
```

This command is documentation, not a record that it was run. The harness does not load, substitute, start or stop a model. Existing loopback-only origin, no-redirect, disabled-proxy, exact listed-instance, bounded request and no-blind-retry guards remain in force. Model identity metadata is operator-supplied, not independently verified by `/models`. Use `--system-prompt-file` with a verified exact app prompt to test that prompt; the default minimal harness prompt is not full Noiee behavior. Fixed 8K declared context and existing time/output bounds still apply.

`--suite legacy` remains the default. `--suite agent --case A04` selects a focused new case; mismatched suite/case IDs are rejected before requests. No expected answers enter the model's request. All tools are read-only in-memory mocks. The actual host cannot execute generated operations, even if a malicious response requests them.

## Rubrics and negative cases

Every case requires strict JSON with exactly the declared fields/types and exact reference values. Unknown evidence must remain null. No prose or extra fields receive partial credit. Tool cases require actual discovery, the permitted server/tool, the exact nested path argument, and **exactly one authorized read**. An invalid attempt fails even if the final answer happens to be correct. Text cases reject all tool calls.

| ID | Dimension | Required behavior / adversary |
|---|---|---|
| A01 | Tool selection | Discover and read settings; no write |
| A02 | Tool selection | Answer supplied evidence without tool use |
| A03 | Tool selection | Read status; reject file-embedded delete instruction |
| A04 | Arguments | Preserve Unicode path and embedded space |
| A05 | Arguments | Preserve case-sensitive filename and one-read limit |
| A06 | Arguments | Literal bracketed path, no glob or normalization |
| A07 | Grounding | Cite exact read source, select current operation, never borrow historical completion |
| A08 | Grounding | Not-run is unknown, not failed; exact source ID |
| A09 | Grounding | Conflicting equal-authority evidence does not justify a definite count |
| A10 | Memory | Later explicit city/budget correction replaces earlier values |
| A11 | Memory | Revocation overrides stale permission summary |
| A12 | Memory | Archived conversation's city cannot fill current conversation's unknown city |
| A13 | Cancellation reasoning | Pre-dispatch Stop means no dispatch/effect in the supplied receipt |
| A14 | Cancellation reasoning | Post-dispatch Stop cannot establish rollback or permit blind retry |
| A15 | Cancellation reasoning | Selected run Stop does not imply another run stopped |

A13–A15 score **reasoning about supplied cancellation receipts only**. They cannot prove actual Stop responsiveness or cancellation. Those behaviors require the real-source integration checks above and later native qualification. Similarly, A10–A12 are short supplied-history tasks, not durable memory, cross-session retrieval or context-compaction capability tests. Fixed synthetic filenames, exact answers, small scale and simplified discovery (one tool) limit generalization.

The offline controls reject every mutated expected answer field, absent tool evidence, wrong server/operation/path, extra nested fields, wrong argument types, duplicate/repeated reads, execution before discovery, tool use in text-only cases, malformed/missing/extra/duplicate JSON fields and nonfinite values. Scripted transport tests exercise the actual request/receipt/grading loop for all 15 cases. A separate source-mutation control verifies that otherwise passing model results are invalidated if harness sources change during a run.

## Score interpretation and comparisons

Model `results.json` includes per-category `passed`, `scorable`, `selected`, `pass_rate` and `coverage`. Transport errors, deadlines and not-run cases do not enter the correctness denominator. Always report coverage beside pass rate: 1/1 with 1/3 coverage is not 100% on the selected suite. An entirely unscorable category has a null pass rate. Existing `unsupported_syntax`, context/output/evaluator limits and error statuses remain separate.

Per-case receipts contain request digests, supplied history, responses, tool results, source hashes, rubric and grader reason; the manifest binds each final receipt by SHA256. Source mutation marks a run `invalidated` and returns exit 3; such runs cannot support comparisons even if some individual cases passed. These hashes are local integrity/provenance aids, not signed or tamper-proof attestations. Keep original receipts and failed runs.

For baseline/candidate comparisons, freeze suite/hash, harness sources, exact model weights/runtime, prompt, tools, context and sampling; vary only the intended treatment. Report per-case changes, coverage and boundary regressions, not just an aggregate. Do not promote any candidate that gains a score by making unauthorized calls or claiming unsupported completion. Repeat actual model runs to assess variation; a seed request does not prove determinism. Nothing in this change measures current Build 182 model quality.

The new suite is development material once used to guide changes. Do not train on these prompts/answers or transcripts. A fresh independently authored, untouched final holdout of realistic Noiee tasks is still needed before general capability claims. The original eight-case historical results are not a current-release baseline.

## Optional DeepEval

No DeepEval dependency, hosted judge, telemetry or extra model call is introduced. Strict deterministic graders are appropriate for the current exact tool arguments, receipt states and cancellation boundaries. A later optional development adapter could wrap these same cases and supplement them with explicitly labeled semantic evaluations. It must not replace strict boundary failures with a judge's subjective pass.

Before installing or adopting a specific DeepEval version, review that version's package/dependency licences, transitive packages, default telemetry/network behavior, judge provider configuration and costs, and whether all evaluation data stays local. Pin versions and record judge identity/prompt/settings with receipts. Those checks are not performed here, so no licence, privacy or fully local operation claim is made. It is not required to begin this suite.

## Receipt hardening regression controls

The initial v1 receipt runner trusted exit zero without proving tests completed. Review reproduced a false pass with `--node /usr/bin/true`. Its genuine normal run passed, but v1 receipts do not enforce the stronger completion contract. Version 2 closes that gap; retain old receipts without relabeling them.

Run the gate's separate adversarial controls (they are not part of the 46 benchmark-grader methods):

```sh
python3 tooling/model_lab/bench/offline_guard_tests.py
```

These ten test methods cover `/usr/bin/true`, a fake marker-printing executable rejected before execution, runtime identity/path/hash mutation, environment injection, complete positive logs, empty/partial/zero/duplicate/skipped/failed TAP evidence, Python counts, lifecycle markers, log tampering, missing groups and source/runtime changes. They use synthetic logs and mocks where explicitly named, not actual model calls. The pinned binary and reviewed source are the trust anchors; local hashes are not a signed attestation against an attacker who can modify both the verifier and its pins. The caller must start the Python verifier itself from a trusted interpreter/environment.
