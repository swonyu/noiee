# Noiee

Noiee is the native macOS local AI workspace formerly named Saleh Uncensored. This checkout is the versioned development source for Build 175. The accepted Build 174 predecessor is retained at tag `noiee-build174`; the original Build 171 source and its `noiee-build171-source` baseline remain separate and unchanged.

## Layout

- `source/`: native Swift app, local Node backend, Chat/Agent and Tasks frontends, and their existing checks.
- `checks/compaction/`: isolated summary, request-admission, recovery and browser regressions.
- `tests/presentation-check.mjs` and `tests/workbench-check.mjs`: real-browser checks of rendering, command dispatch, focus, drafts and tool-authority labels.
- `tooling/`: native compilation, startup checks, preserved integration suites, qualification and the reviewed host release adapter.
- `.artifacts/`: exclusive generated evidence, omitted from Git. Generated runtime homes and browser profiles use private Caches directories.

The `source/node_modules` link points to the verified owned dependency snapshot at `/Users/saleh/Documents/Noiee/dependencies/node-26.13.0-build171`. The dependency versions are pinned in `source/package-lock.json`; they have not been upgraded in this workflow release. Development commands use `--preserve-symlinks` because the copied dependency directory has a descriptive name. The signed application embeds its own dependency tree.

## Workflow improvements

The shared command palette opens with Cmd+Shift+P or the existing Cmd+J shortcut. Commands call existing guarded controls and preserve drafts; Cmd+K remains New chat. The Chat composer states that tools are off, while Agent shows the current launch policy. Delegated Tasks show their own result and a verified Return to parent action. Explicit inherited-parent history is collapsed, and command execution remains separate from verification. Retained failed startups have a bounded recovery summary.

The Tasks Goal panel saves an objective, explicit completion criteria and a 1–20 continuation-attempt limit. Save, inspection, pause, resume and reopening do not start work. Continue goal requests one turn through ordinary native task admission, using the visible Plan/Build and Standard/Deep settings. Pause blocks the next continuation; the existing Stop control interrupts current work. The Goal keeps its own editor draft while preserving the ordinary message draft. Completion requires a deliberate review with saved evidence and does not establish automatic verification.

Goal attempts keep exact turn identity, contract revision and digest, the limit at dispatch, and the observed outcome. Changed criteria do not reset consumed attempts. A raised exhausted limit stays paused until explicit Resume. Uncertain starts consume their reserved attempt and are never retried automatically. Completed Goals remain read-only; archived root tasks can inspect their saved Goal. The retained Goal ledger is bounded to 64 contracts and 8 MiB; reaching a bound refuses the next write without deleting history. Automatic multi-turn pursuit and enforced token budgets are not implemented.

Ordinary Chat/Agent receipts now retain a bounded, versioned observation of Enter, Send, form submission or Retry, with event trust, page focus and visibility. These page observations contain no keystroke stream or extra message body and grant no authority. They are part of the existing input digest and admission identity. Legacy receipts remain readable without rewriting. Composition, repeated Enter and already-prevented keyboard events are guarded; an unattributed programmatic form submission is labeled as such. This does not establish who initiated a historical request.

[CODEX_PARITY.md](CODEX_PARITY.md) records the scoped parity target, existing capabilities, and remaining gaps. Source implementation, generated qualification and installed native acceptance are separate evidence.

## Runtime contracts

The native app checks the exact qualified Node executable declared in `source/runtime-contract.json`. Tasks separately checks the installed Codex binary and initialization protocol against `source/coding-runtime-contract.json`. These runtimes are externally installed. A future binary change requires compatibility qualification and an updated contract.

Local model identity is exact. Existing saved selections remain pinned. Fresh preferences use the shared catalog-backed picker; missing, unloaded, ambiguous and unavailable selections remain explicit. The picker does not load or download models.

Tasks derives its execution context and automatic-compaction threshold from the actual loaded model window. A changed window stops admission and relay dispatch until the app restarts. Retained app-owned configuration bytes and model identities are preserved. Concise and Detailed styles change response instructions while retaining the existing uncapped generation policy; context capacity and Stop still apply.

## Development and verification

Use a clean committed checkout for a release build:

```sh
python3 -B tooling/build_native.py --build 175
```

This compiles all native sources and runs the built-in native checks without opening the installed app. Each run creates an exclusive receipt containing source, compiler, SDK, command, binary and log hashes. A `--development` build is explicitly ineligible for release.

See [tooling/README.md](tooling/README.md) for startup checks and backup coverage inspection. See [tooling/RELEASE.md](tooling/RELEASE.md) for the complete Build 174 to Build 175 qualification, capture, signing and guarded installation process. Do not run a historic release recipe or rewrite a prior receipt.

`tooling/check_live_profile.mjs` is an explicitly invoked real-model qualification harness. It uses a generated project and isolated native engine home; its result is separate from installed native UI acceptance. Live tests must run serially under the release owner. Never label generated fixtures or a compiler check as a completed user task.

## Preserved data boundaries

The visible app is Noiee. Its physical bundle remains `/Users/saleh/Applications/Saleh Uncensored.app` and its identifier remains `com.saleh.qwenlocal.chat` to retain the existing signed identity and data association.

Chat JSON export covers Chat/Agent conversations and exported attachments. It does not cover Tasks history or native settings. A release backup covers the four declared original stores and retains the exact signed predecessor bundle. No automatic old-history deletion, backup pruning or post-launch data rollback is part of this update.

Conversation summaries retain original messages, drafts and attachments. Each explicit Compact operation processes up to 24,000 UTF-8 bytes of serialized history, including carried summary and fragment metadata. Oversized exchanges use pinned UTF-8 cursors; partial exchanges remain fully in request history until all their bytes are covered. New results must fit both the 12,000-byte raw summary bound and 16,000-byte encoded carry bound. Older valid summaries that exceed the carry budget remain retained while the next round explicitly rebuilds from originals. Ordinary responses keep their existing generation policy.

Full-history selection, rebuilding, saved progress and activation use the existing storage compare-and-swap. The newest exchange always stays in full; unfinished or unsettled exchanges block compaction. Metadata retains up to 64 current and 2,048 archived attempts within a 32 MiB bound. Reaching a retained-data bound refuses the next attempt without discarding history. Exporting does not reset those limits.
