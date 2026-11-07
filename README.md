# Noiee

Noiee is the native macOS local AI workspace formerly named Saleh Uncensored. This checkout is the versioned development source for Build 172. Its baseline is tagged `noiee-build171-source`; the original Build 171 source and release evidence remain separate and unchanged.

## Layout

- `source/`: native Swift app, local Node backend, Chat/Agent and Tasks frontends, and their existing checks.
- `checks/compaction/`: isolated summary, request-admission, recovery and browser regressions.
- `tests/presentation-check.mjs`: real-browser checks of safe Chat/Tasks rendering and reasoning placement.
- `tooling/`: native compilation, startup checks, preserved integration suites, qualification and the reviewed host release adapter.
- `.artifacts/`: exclusive generated evidence, omitted from Git. Generated runtime homes and browser profiles use private Caches directories.

The `source/node_modules` link points to the verified owned dependency snapshot at `/Users/saleh/Documents/Noiee/dependencies/node-26.13.0-build171`. The dependency versions are pinned in `source/package-lock.json`; they have not been upgraded in this stabilization release. Development commands use `--preserve-symlinks` because the copied dependency directory has a descriptive name. The signed application embeds its own dependency tree.

## Runtime contracts

The native app checks the exact qualified Node executable declared in `source/runtime-contract.json`. Tasks separately checks the installed Codex binary and initialization protocol against `source/coding-runtime-contract.json`. These runtimes are externally installed. A future binary change requires compatibility qualification and an updated contract.

Local model identity is exact. Existing saved selections remain pinned. Fresh preferences use the shared catalog-backed picker; missing, unloaded, ambiguous and unavailable selections remain explicit. The picker does not load or download models.

Tasks derives its execution context and automatic-compaction threshold from the actual loaded model window. A changed window stops admission and relay dispatch until the app restarts. Retained app-owned configuration bytes and model identities are preserved. Concise and Detailed styles change response instructions while retaining the existing uncapped generation policy; context capacity and Stop still apply.

## Development and verification

Use a clean committed checkout for a release build:

```sh
python3 -B tooling/build_native.py --build 172
```

This compiles all native sources and runs the built-in native checks without opening the installed app. Each run creates an exclusive receipt containing source, compiler, SDK, command, binary and log hashes. A `--development` build is explicitly ineligible for release.

See [tooling/README.md](tooling/README.md) for startup checks and backup coverage inspection. See [tooling/RELEASE.md](tooling/RELEASE.md) for the complete Build 171 to Build 172 qualification, capture, signing and guarded installation process. Do not run a historic release recipe or rewrite a prior receipt.

`tooling/check_live_profile.mjs` is an explicitly invoked real-model qualification harness. It uses a generated project and isolated native engine home; its result is separate from installed native UI acceptance. Live tests must run serially under the release owner. Never label generated fixtures or a compiler check as a completed user task.

## Preserved data boundaries

The visible app is Noiee. Its physical bundle remains `/Users/saleh/Applications/Saleh Uncensored.app` and its identifier remains `com.saleh.qwenlocal.chat` to retain the existing signed identity and data association.

Chat JSON export covers Chat/Agent conversations and exported attachments. It does not cover Tasks history or native settings. A release backup covers the four declared original stores and retains the exact signed predecessor bundle. No automatic old-history deletion, backup pruning or post-launch data rollback is part of this update.

Conversation summaries retain original messages, drafts and attachments. Full-history selection and rebuilding use the existing storage compare-and-swap. Summary input remains limited to complete exchanges within 24,000 UTF-8 bytes per step, with 64 retained attempts. Oversized or unsettled exchanges are reported explicitly; they are not silently clipped or hidden by a summary.
