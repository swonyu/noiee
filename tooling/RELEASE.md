# Host release: Build 175 to Build 176

This adapter is an explicitly host-bound update of the already signed Noiee app. The native compiler in `build_native.py` is separate: it compiles and checks source without signing, preparing an admission, replacing an app, or reading original stores.

The host adapter retains the installed bundle path `/Users/saleh/Applications/Saleh Uncensored.app`, identifier `com.saleh.qwenlocal.chat`, executable name `QwenLocal`, existing signing requirement, four data-store paths, and authentic history admission chain. Visible bundle names are Noiee, and the new bundle version is 176. It is not a portable distribution installer: the current runtime, owned runtime paths, certificate, predecessor and data-directory identity are specific to this Mac.

## Guard provenance

The three files under `release_helpers` are exact copies of the pinned Build40 implementations. Their bytes are checked before importing definitions. `PROVENANCE.json` records the original path, digest and size. The original files remain unchanged.

The adapter extracts only `copy_exact`, `replace_bundle`, and `observe_model_listener` from the applicable modules. The two human-readable transaction labels use Build176; the replacement/rollback guards and control flow are unchanged. The filesystem identity function is an unchanged extraction of the pinned Build88 function, with the digest-checked current Node executable and the adapter's `require` supplied explicitly.

Historical Build171, Build172, Build173, Build174 and Build175 source, recipes, receipts, archives and rollback are never rewritten. The Build175 predecessor is the signed package at `Noiee175-o6h8s6co`, bound to commit `3057807edf1094d2179a8b4cd3eeeecfff2907b8`. New capture/config/freeze files belong under `/Users/saleh/Documents/Noiee/releases/build176`; staging, backups, intent and installation transactions each use new exclusive names.

## Required evidence

Commit the complete integrated project first. Production release phases refuse development worktrees, dirty tracked/untracked checkout contents, source changes after freezing, or source files that do not exactly match the tracked source namespace. The freeze binds all source and tracked tooling files, including helper bytes, fixture code and builder code, to the Git commit. The current source resource namespace is flat; adding a source directory or removing an old file requires an explicit packaging change.

The four existing Fetch runtime payload/contract files must retain their exact signed Build171 source hashes; this release does not replace or requalify those immutable bytes.

The stable dependency copy is `/Users/saleh/Documents/Noiee/dependencies/node-26.13.0-build171`. Its complete contents must still match the trusted predecessor dependency manifest. The external Node runtime is exactly the version and executable digest declared in `source/runtime-contract.json`; an updated executable requires explicit qualification, not a silent version range.

Use a fresh schema2 native receipt produced from the clean final integrated commit:

```sh
python3 -B /Users/saleh/Documents/Noiee/project/tooling/build_native.py --build 176
```

The host adapter checks release eligibility; the complete source and Swift inventory; compiler, SDK, builder and command provenance; native binary bytes; and the real compiler/self-check logs. A development artifact, stale commit, failed self-check or omitted Swift file is rejected. Native compilation and the existing `--check-computer` self-check do not establish installed UI or live model acceptance.

The schema1 qualification report must contain:

```json
{
  "schemaVersion": 1,
  "gitCommit": "<final integrated commit>",
  "sourcePins": {"<each regular source basename>": "<sha256>"},
  "sourceUnchanged": true,
  "suites": [{
    "name": "<required suite>",
    "command": ["<actual executable>", "<actual arguments>"],
    "exitCode": 0,
    "passed": 1,
    "failed": 0,
    "log": {"path": "<actual output log>", "sha256": "<sha256>"},
    "result": {"path": "<actual execution RESULT.json>", "sha256": "<sha256>"},
    "scope": "<what was actually exercised>"
  }]
}
```

The illustrative count above is not an expected test count. Use the actual fresh count; zero counts and failures are rejected. Required unique names are `compaction-recovery`, `model-stabilization`, `startup-diagnostics`, `presentation`, `catalog`, `goals`, `submission-origin`, `mcp-skills`, `fetch`, and `worktrees`. All ten must be freshly exercised against the final integrated source. No earlier pass count is inherited. The runner also executes the generated `release-inputs` suite against the current adapter.

The `catalog` suite executes `source/coding-catalog-check.mjs` against generated saved owner/history fixtures and `source/coding-catalog-ui-check.mjs` against the actual page loading and result-navigation controllers with generated callbacks. Each command must emit one terminal JSON result named `coding-catalog` or `coding-catalog-ui`, with nonempty unique assertion names, a numeric pass count equal to their length, and zero failures; duplicate, missing or incomplete results are rejected. Counts come from the current executions.

The `goals` suite executes the complete shared-engine regression fixture, generated Goal ledger/dispatch checks, and dedicated Tasks UI checks. The engine fixture must report `fullSuite: true` after cleanup, with its full-run and final error-scope completion markers; partial or truncated executions are rejected. The `submission-origin` suite executes the Chat receipt checks and the dedicated browser composition/input-origin checks. Both retain actual unique assertion names and counts. These cases use generated state and fake engine/upstream callbacks; they do not establish native accessibility, real inference or installed-app acceptance.

Each suite's real execution result has numeric `exitCode: 0`, `sourceDirectory`, `sourceUnchanged: true`, and `sourcePins`; pass/failure counts can be at the top level or under `result` for the startup fixture. If command/log/name/commit fields are recorded, they must match the normalized row. Aggregate constituent rows retain their actual commands and exit codes; recorded count totals must agree. Source pins may be complete source basenames or a subset using source basenames/tracked project-relative fixture paths.

All referenced logs and results must be regular, single-link, owned files under the integrated `project/.artifacts`, `updates/build176` or `releases/build176` roots. Suite log/result paths are distinct. Nested artifact references in the result are hash checked; nested raw JSON is retained as evidence without rewriting its original execution paths. A runner that uses generated Caches fixtures must preserve the evidence under the allowed artifact roots.

## Explicit release phases

The following are operational instructions for the release owner. Authoring or testing this tooling does not execute these steps. Every phase is a separate invocation; the host adapter never launches the app or a model.

1. Finish and review the integrated commit. Run the fresh qualifications and native build, then leave the source unchanged. Create an owned, canonical, private `releases/build176` directory.
2. Freeze with `release_host.py freeze --output /Users/saleh/Documents/Noiee/releases/build176/source-manifest.json`. The output is exclusive and binds the final commit, source and tracked tooling.
3. Quit Noiee normally and confirm its work is closed. Run `capture_closed_boundary.py --output /Users/saleh/Documents/Noiee/releases/build176/closed-boundary-<unique>.json`. It refuses an active/unknown process or port 8787, a retained owner lease, or a native reader not recorded closed. It performs two equal complete observations of the signed Build175 bundle and all four original stores. It reads filesystem metadata/bytes only; it does not open SQLite, recover an owner, clear a lease or claim historical normal-Quit/native acceptance.
4. Create a new `release-input.json` containing exactly `version:1`, `build:176`, `sourceDirectory` for the integrated source, and `sourceManifest`, `closedBoundary`, `nativeBuild`, `qualification` references. Each reference has exactly `path` and `sha256`. Use the actual fresh files/digests.
5. Run `release_host.py prepare --input <release-input.json> --sha256 <input digest>`. Review the emitted `prepared.json`, resource delta, commit and evidence before the next phase.
6. Run `release_host.py build --stage <Noiee176-stage> --sha256 <prepared digest>`. This reuses the validated native binary, generates a successor admission bound to the authentic saved predecessor, signs with the existing identity, checks exact resource/signature scope, archives, extracts, and verifies the round trip. Review the new `candidate-receipt.json`.
7. Run `release_host.py install --stage <Noiee176-stage> --sha256 <candidate receipt digest>` only when the release owner has completed review. It revalidates inputs and the stopped boundary, makes complete exact backups of the four stores, retains the exact signed Build175 bundle, and uses the unchanged guarded rename transaction.

Every write target is exclusive. A failed attempt is retained for diagnosis and cannot be silently resumed. If source, runtime, predecessor, owner boundary or data changes, stop and preserve the evidence; do not edit accepted receipts or bypass a guard.

## Receipts and rollback limits

`prepared.json` records the input, freeze, staged source, resource changes, approved plist and evidence. `candidate-receipt.json` binds the signed candidate manifest, archive and unchanged signing requirement. `installation-journal.json` records each rename and any refusal or rollback error. `installation.json` records the final bundle verification, unchanged original stores, exact backup/rollback locations, and model listener observations.

The backup has one manifest covering the exact keys `Qwen Local`, `WebKit`, `HTTPStorages` and `preferences.plist`, including explicitly absent stores, and a `backup-receipt.json` describing each copy. The signed rollback is `Build175-original.app` under the unique sibling transaction directory. There is no original-store restore or cleanup command.

Automatic bundle restoration exists only inside the synchronous guarded transaction while the application remains closed and original data is unchanged. Any observed writer, uncertain stopped state, app launch, changed data or unknown bundle forbids an automatic downgrade. The journal then names the preserved bundles and requires independent recovery review. A later downgrade after first launch is not authorized or implemented by this adapter.

Successful installation still records `launched:false`, `nativeAcceptancePassed:false` and `productionAcceptance:"pending"`. The release owner must separately exercise the installed native app: startup and diagnostics, ordinary quit/immediate reopen, chat/Tasks history and intended workflow behavior, selected model compatibility and a representative task, all with truthful fresh evidence. A generated fixture suite or native self-check must never be relabeled as that live acceptance.

## Isolated input checks

```sh
python3 -B -m unittest discover -s tooling/tests -p test_release_inputs.py
```

These checks construct explicitly synthetic files in private temporary directories and call only pure input validators. They cover stale/dirty/native provenance, missing/duplicate/failing suites, mismatched counts/commands, altered logs, foreign or linked artifact paths and incomplete Swift inventory. They do not execute capture, prepare, package, install, app, model, or original-store operations.


## Workflow parity release and native acceptance

Build176 binds the exact signed Build175 predecessor. Its source and tooling changes require fresh complete qualification, native compilation, a new stopped-store boundary, signed candidate and archive verification, and the unchanged guarded installation transaction. Build175 artifacts and its native acceptance remain immutable.

Prior model observations do not replace fresh native acceptance. Exercise every changed workflow, its retained state, ordinary Quit/cold reopen, and affected Chat/Tasks keyboard and focus behavior. Affected Goals or submission-provenance behavior needs specific persistence, pause/resume, completion-evidence and input-origin checks; record only behavior actually exercised. Retain the Build174 command-palette, tool-authority, delegated-result and fragmented-compaction boundaries and the Build175 explicit-Goal, completion-evidence and submission-observation limits. Catalog and Goal-inspector changes need fresh saved-history loading, empty/incomplete history, selection, draft and archived-state checks; distinguish instrumented latency from time between manual observations. Preserve truthful partial-progress and legacy-summary states. Only complete source coverage may be projected as compacted.

The installed local model, loaded context, runtime contracts and provider configuration remain governed by their existing checks. Compaction-specific output bounds do not create a cap on ordinary replies. Release input and native acceptance helpers use new Build176 artifact paths; historical helpers and receipts are not relabeled. No automatic downgrade or data restore is permitted after the new app launches.


## Accepted predecessor and status finalization

The accepted Build175 source is `3057807edf1094d2179a8b4cd3eeeecfff2907b8`, tagged `noiee-build175`. Its frozen project manifest is `/Users/saleh/Documents/Noiee/releases/build175/source-manifest.json`, SHA256 `b6e2546878d4a55f07bba7754cd3b2cc5bf2bb77c60a69fd571f3b934b692fd6`. This is distinct from the predecessor packaging manifest under `Noiee175-o6h8s6co` that `OLD_PINS` binds. Build175 native acceptance remains `passed_with_known_limits`; its unresolved observations are not closed merely by producing Build176. Its accepted report is `releases/build175/native-acceptance.json`, SHA256 `1f79f49d1b95904cb18fca23189ed6685a0537b5ba4e072a9e23918948a09e13`; the finalization receipt is `releases/build175/finalization.json`, SHA256 `ee2476be67f1d98ed4fce91e2cc302779de1dacc78afa35139d20398c2599836`.

The predecessor staging directory is `/Users/saleh/Library/Application Support/Saleh Uncensored Release Staging/Noiee175-o6h8s6co`. The capture and adapter pin these saved artifacts, independently of the new stopped-store capture:

| Predecessor artifact | SHA256 |
| --- | --- |
| `source-manifest.json` | `de2fba0f43c61c6c601e50000f576e487a94958b88e1c7f33063665d9df00db0` |
| `candidate-bundle-manifest.json` | `d0b6d532d1d007fc894d7a74cf27e04d6c6570d247a8a06a8340b374590d9acf` |
| `candidate-receipt.json` | `1d939e1de63b62a42694fdc8ac27842d440103135a973e3429a4db492fd0d82b` |
| `installation.json` | `4f72b9ad0d1b82ae70eb4394d274bb7066efe04edff341cea7d193a0bb1dd520` |
| Signed `QwenLocal` binary | `6abc9c36b5d093cedec20e022e6b076699b338f961900d745943afe3faae5883` |

The package, source and bundle manifest digests are code-enforced predecessor pins; the installation and accepted report references document the accepted baseline and are not a replacement for fresh runtime or stopped-store checks.

The host adapter never writes `/Users/saleh/Documents/Noiee/STATUS.json`. Before finalization, preserve its exact accepted Build175 bytes exclusively at `/Users/saleh/Documents/Noiee/releases/build176/STATUS.before-build176.json`. The reviewed predecessor SHA256 is `707e7382ebe1ca090a942b40ffb25562e5b7f05cc8d5730f7f1315e19cf0e209`. The finalizer must re-read and compare that digest immediately before replacement; any concurrent status change requires review. Do not replace the accepted status until fresh Build176 native acceptance exists. The successor status must reference the preserved predecessor, final integrated commit/tag, actual qualification and installation receipts, current-use evidence and any remaining limitations.

Keep the Build175 candidate and installation receipts unchanged, including their historical phase-specific `launched:false` and pending-acceptance fields. The same rule applies to Build176 receipts after its later first launch. The checked-in `native_acceptance.swift` is a historical Build173 helper; create separately reviewed Build176 acceptance tooling and evidence under new `updates/build176` paths. Neither a status update nor an acceptance helper authorizes automatic downgrade after launch or alteration of ownership/admission records.

## Receipt compatibility inherited from Build175

Build175 reads legacy Chat run receipts without migration. New ordinary receipts may contain the optional versioned submission observation, bound to the input digest. Build174's prior exact-key validator does not understand that field. Forward reading of existing data is qualified; downgrade compatibility after Build175 has written new receipts is not claimed. The existing prohibition on automatic downgrade after first launch remains mandatory.

Build176 continues the Build175 receipt format and reads the same legacy records without migration. Native acceptance must retain the open Build174 unexpected-draft-submission observation and the inherited compaction timeout/retry limits unless specific new evidence closes them. The installed local Qwen provider is unchanged; no Astra provider installation or full Codex parity is implied.
