# Offline account and external-tool qualification

This successor runner executes the existing focused fixtures against the **current clean, committed checkout**, rather than copying a historical success receipt. It is not a release adapter and does not modify Build181 qualification, host adapters, historical fixtures, the installed app, accounts or settings. Full native app compilation remains a separate gate. Drive is not covered.

## Invocation

From the checkout root, first provide the existing shared dependency snapshot through the already documented link (no dependency installation or download):

```sh
ln -s /Users/saleh/Documents/Noiee/dependencies/node-26.13.0-build171 source/node_modules
python3 -B tooling/integration/account-extensions/run.py run
```

Do not recreate an existing link. The runner refuses missing or different links, dependencies, Node bytes/version, missing/tampered fixtures, source symlinks, ignored files injected into executable namespaces and a dirty checkout. `CONTRACT.json` pins the reviewed fixture bytes and the complete 5,888-entry shared dependency namespace. Updating a fixture requires a deliberate reviewed contract change, not changing the expected count to make a failed run pass.

Every run creates an exclusive `.artifacts/integration/account-extensions-*/` evidence directory. It prints each completed gate and one final JSON object containing `passed`, the absolute `receipt.path`, its exact SHA-256 and byte count. Exit zero is necessary but insufficient: a caller must retain that expected digest and validate the complete receipt against the intended commit:

```sh
python3 -B tooling/integration/account-extensions/run.py verify \
  --receipt /absolute/path/to/RESULT.json \
  --sha256 <exact-digest-returned-by-run> \
  --commit <expected-full-commit>
```

The verifier requires the same checkout path and unchanged current source, runtimes and dependencies. A later cherry-pick or source change needs a fresh run. There is no subset, skip, development override, host install adapter or build number option. A future qualifier can invoke `run`, independently verify its returned digest/commit, and retain the full evidence directory as **one mandatory offline gate**, alongside separate compilation, review and any authorized live acceptance.

## Receipt contract

- `schemaVersion: 1`, `kind: noiee-offline-account-extensions`, `status: passed`, `complete: true`, `releaseEligible: false`.
- `INPUTS.before.json` and `INPUTS.after.json` are independently hashed references. They must match exactly: full tracked source/fixture hashes, byte sizes/modes, clean Git commit, exact dependency files/links/modes, Node/Python/compiler launcher/compiler/SDK identities and sandbox policy.
- All mandatory rows must appear once, in order. Each retains exact command/cwd, exit status, bounded combined log, elapsed time and independently parsed result. Logs are capped at 1 MiB and commands at 180 seconds; overflow, timeout, signal/nonzero exit or missing output fails closed. Owned process groups are killed on exit to prevent retained fixture descendants.
- The unchanged Python scripts execute through `invoke-python.py`. It records each actual completed subprocess argv, exit status, executable hash, input hashes before/after and compiled output hashes. The verifier requires each fixture’s complete ordered compiler argv and exact source/input maps, executable/cwd and output contracts. The aggregate generated Swift is reconstructed from pinned fixture fragments. Node parity requires the exact reviewed embedded script, fixed synthetic revision, module URL, private paths and full native validation argv, with the Node review.json output hash linked to the native input. The Node-to-Swift review parity must actually run, not merely compile. Generated compiler inputs and disposable binary hashes remain in these records after temporary files are cleaned up.
- Every terminal marker must be exact and final. Native assertions, static routing JSON and parity output must all be present; duplicate keys/markers, partial/native receipts and trailing output are rejected. TAP requires all seven exact named top-level cases, a complete final plan/summary, and zero failed/cancelled/skipped/todo cases. A zero-test run cannot qualify.
- The separately hashed NATIVE-EVIDENCE.json must match this receipt’s exact source snapshot, fixture home and completed native rows. Logs, input snapshots and receipt references must be unique, regular single-link files without symlink ancestors. Verification checks their retained byte counts and SHA-256, reparses all outputs and recomputes totals. A failed or partial run remains evidence only and never qualifies.

## Honest coverage units

The fixtures currently report **793 native assertions**: foundation 197, GitHub 256, Gmail 187, aggregate Stop 17, inert-install 60 and launch 76. The aggregate Stop fixture executes actual injected GitHub/Gmail status and checks that cancellation prevents later refresh or result publication. These are assertion totals, not independent test-case counts.

Other units remain separate:

- Seven named Tools controller TAP test cases.
- Six real durable Agent claim families, including install/inspect/connect/disconnect/status and managed-server connect. They are not six additional TAP tests.
- Five completion-only JavaScript suites: account schema/native routing, local destination, download parser/transport, signed routes and external runtime. Their internal assertion totals are not invented.
- Real production Node review/native canonical-digest validation and fixed-loader parity.
- Agent syntax check, not a behavior test.
- A separate mandatory gate mutates the current run’s genuine native child records in memory across 45 named mutation cases. It rejects removed, replaced, reordered and extra sources/maps/outputs; executable/cwd changes; partial rows; generated-source drift; and altered parity scripts, arguments and review handoff. Original evidence files are not changed.
- Separately counted runner adversarial tests for missing, altered, linked, duplicate, nonfinal, zero-test, skipped/todo/cancelled/partial evidence, timeouts and log overflow.

## Offline boundaries and limits

All suites and descendants run with macOS `sandbox-exec` denying `network*`, a minimal environment, and disposable HOME/TMPDIR. Auth fixtures inject transports, listener behavior, stores and consent; they never construct live Keychain/account/browser/UI flows or production listening sockets. Network denial is an added enforcement boundary, not a live provider test.

The runtime fixture executes only locally authored synthetic loader and stdio processes. The reviewed downloaded-artifact path remains inert. No unknown or downloaded program is executed; no model, installed app, real account, user store, release phase or actual download is involved. Runtime-child execution itself is not an OS isolation demonstration for real external tools.

This evidence does not establish real Gmail/GitHub consent, provider policy eligibility, UI usability, actual Keychain behavior, production URLSession/loopback behavior, installed lifecycle acceptance, Drive selection, unknown-tool safety, or release readiness. Source/file pre/post hashes are not protection against a malicious same-user process changing and restoring inputs mid-run. The verifier and receipt digest must themselves be taken from the reviewed trusted checkout; a self-authored receipt is not an attestation against that threat model. The existing retained runtime-rerun caveat in `tooling/EXTERNAL_TOOLS.md` remains unchanged.
