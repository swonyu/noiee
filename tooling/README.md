# Native build and startup support

## Native compilation

Run from a committed checkout:

~~~sh
python3 -B tooling/build_native.py --build 176
~~~

The builder compiles the actual Swift inventory into a new private directory under .artifacts/native/, then runs the existing --check-computer validation entry point. It never starts the app UI or a model, signs a bundle, installs an update, opens original stores, or replaces an earlier receipt.

Every build receives an exclusive directory with its command, source manifest, Git commit/status, builder digest, Swift compiler digest/version, Xcode/SDK identity, compiler and self-check logs, native binary digest, and final receipt. --development permits a dirty checkout but makes releaseEligible false. Compilation/self-check failures remain failures with retained evidence.

The native receipt is an input to packaging. It is not an installation or production-acceptance receipt. An unsigned native binary alone is not a runnable Noiee application bundle.

## Declared runtime

source/runtime-contract.json declares the exact qualified Node version and executable digest. The native app resolves only its listed installation paths, checks the digest, runs a bounded --version probe, and rechecks the executable. Unknown versions/executables are refused with a repair/update instruction. Node remains externally installed; this is not a bundled or fully hermetic runtime. Missing linked libraries fail the probe.

The separate Coding engine has its own contract and qualification boundary. Passing the native Node check does not establish Coding model eligibility, Codex protocol compatibility, ownership admission, macOS permissions, or provider readiness. Noiee does not extract or install another app's executable.

## Startup diagnostics

Before starting the backend, Noiee checks the bundled runtime contract, workspace configuration, backend entry point, qualified Node runtime and local port. Missing/invalid resources, unavailable/incompatible runtimes, occupied ports, missing backend dependencies, JavaScript load errors, early exit and readiness timeout have different categories.

Diagnostics → Startup Report shows the most recent launch result and offers its receipt in Finder. Each receipt is a new private JSON file under ~/Library/Logs/Noiee/Startup/. Startup stderr capture is limited to 8 KiB in memory; persisted reports contain only recognized codes/categories and byte counts. Unknown text, source excerpts, environment values, credentials and paths from stderr are omitted. After readiness, capture is cleared and later provider/tool stderr is drained without being recorded.

Startup reports are support evidence, not proof of completed user tasks, clean shutdown, model quality or original-store integrity. Receipt-write failure is visible and does not convert successful server startup into failure.

## Isolated checks

~~~sh
python3 -B tooling/check_startup.py
python3 -B tooling/tests/test_build_tools.py
~~~

Startup checks compile the real startup code with generated configuration, process, socket and report fixtures. They never launch the installed app, invoke a model, probe its actual port, or open original app stores. Artifact paths and source hashes remain under .artifacts/.

## Backup coverage inventory

~~~sh
python3 -B tooling/backup_inventory.py --backup-root "$HOME/Library/Application Support/Saleh Uncensored Backups"
~~~

This command reads immediate directory metadata and bounded backup receipts. It does not traverse payloads, read original stores, rehash copies, restore, prune or modify anything. It distinguishes declared coverage, missing copies, older/unknown receipt formats and linked entries. A past receipt is not a fresh restore test.

Chat JSON exports contain Chat histories and associated exported chat data. They do not include Tasks histories or a complete workspace backup. Release backups cover four explicitly declared original stores. Retention decisions must account for active runtime, admission and rollback dependencies; directory age alone is not deletion authority.

## Packaging and installation boundary

For the 175→176 update, preserve the existing bundle identifier, designated signing requirement, physical application path, original data directory and authentic successor-admission lineage. Historical Build 171, Build 172, Build 173, Build 174 and Build 175 source, receipts, backups, and release adapters remain immutable.

A host release adapter must bind the committed source freeze, immutable native receipt, actual source-bound check reports, fresh closed-store capture, and exact signed predecessor package. It assembles and verifies a signed candidate and archive, makes a complete four-store backup, and uses the existing guarded replacement/rollback transaction. Native startup support and both runtime contracts must be included in the resource manifest.

Portable source compilation and host-specific installation are separate. Do not edit a historical closure/admission receipt to match a new boot, turn a fixture pass into installed acceptance, or bypass an actual ownership refusal. First-launch task execution and cold reopen are recorded independently.

## Reviewed host update tooling

[RELEASE.md](RELEASE.md) documents the isolated Build175-to-Build176 host adapter, current closed-boundary capture, vendored guard provenance, exact qualification schema, and rollback/acceptance boundaries. The source compiler remains separate from installation.


The accepted Build175 status remains in place until fresh Build176 native acceptance. Preserve it before finalization and use the exact predecessor digest as a compare-and-swap guard, as documented in RELEASE.md. Historical phase receipts and the Build173-specific native acceptance helper remain unchanged.

The fresh full qualifier also requires the generated `catalog` suite for saved Tasks owner/history loading. Its named assertions, the existing Goal suites, and the submission-origin suites report counts from the actual current execution. Earlier native observations and automated totals are not substituted for the new source-bound release qualification.
