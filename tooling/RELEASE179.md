# Build178 to Build179 successor adapter

Use `release_host179.py`, `capture_closed_boundary179.py`, `qualify179.py`, and `tests/test_release_inputs179.py`. Historical scripts, helper pins, archives and receipts remain untouched. The guarded sequence in `RELEASE.md`, `RELEASE177.md` and `RELEASE178.md` applies with candidate 179 and installed predecessor 178. Production phases must run from the clean integrated `/Users/saleh/Documents/Noiee/project`, never a development worktree.

## Installed predecessor evidence

The selected stage is `/Users/saleh/Library/Application Support/Saleh Uncensored Release Staging/Noiee178-m2t7pgid`. Retained artifacts were read and hashed during preparation:

- Source commit: `cca470c3754c3519bea3400629d04cce7eb2ba31`.
- `source-manifest.json`: `9eff48933e6680a4538acc906d9522ed126b368923c526225b2aaa6816589857`.
- `candidate-bundle-manifest.json`: `79382eb91848229bd1504207ce756f0bd203963e4726fbfa9f921069f251ca48`.
- `candidate-receipt.json`: `bf653b5c277f6c5513f51a97eba618b73e42ae04738e20bc4801fa03714eecf2`.
- Retained signed candidate executable: `d0c446c624bf70ce22f7f4f23a37e34fc6edd1e50a0bbaaec66a3cf1606856ec`.
- `installation.json`: `9f176c58c0e48be8150df9597216e4228e9a3934e2a765fd8b8bd9904a6bd7cd`.

Additional retained evidence in `/Users/saleh/Documents/Noiee/releases/build178`:

- `independent-install-audit-20261109T053209Z-3f837edd.json`: `e1338cccd0b81b483625b320af3acb748a8bb2203a40a4e4966a23b02d868ba6`.
- `native-startup-verification-20261109T0537Z.json`: `ca30fe1ff82cb6cead0e7efe3452fc0a28c56bcd4b0eded2f8e0d2dc0431c783`.

These receipts document installation, backup verification and native startup/quit/reopen, not full changed-workflow acceptance. They record the app left open and model server offline. They are historical evidence, not a current closed boundary or store baseline. STATUS.json remains untouched.

## Guards and qualification

All host/capture function ASTs remain identical to Build178 after successor identity substitutions. Signing, pinned helpers and Node runtime, immutable Fetch payloads, original stores, dependency snapshot, ownership closure, two-observation stopped boundary, exact backup, manifests, guarded rename and rollback rules remain unchanged.

All eleven runner suites and ten host-required suites are retained, including the full Coding UI suite, exact completion marker and truthful one-completed-suite scenario count. The model picker fixture stays byte-identical to selected committed source. Existing 900-second command and 1200-second aggregate budgets are unchanged.

The model suite additionally requires:

- `source/model-response-cleanup-check.mjs` and `source/model-cleanup-routes-check.mjs` in the existing Node TAP command. Counts come from actual execution, not invented assertion totals.
- The repaired `source/model-endpoint-check.mjs` as a separate command. Exit zero and exactly one unchanged full six-check completion marker are mandatory. These are six completed endpoint binding checks, not a count of internal assertions.

The endpoint fixture must include the independently reviewed shutdown correction. Integrate the app/fixture batch through `8c08da9` (including `095fefb`, `ca70fc3`, `a703088`) before full qualification. This tooling-only worktree intentionally does not contain those app changes and cannot substitute for final integrated qualification.

The successor synthetic release-input suite executes 52 tests, including predecessor pins, unchanged guard function ASTs, complete model command inventory, preserved Coding UI dispatch, and missing/partial/duplicate completion rejection. No tests in this suite execute a release phase or read original stores.

## Coordinated release sequence

1. Independently review and integrate app changes, repaired fixtures and this adapter, commit, then stop editing. Run `python3 -B tooling/qualify179.py` and `python3 -B tooling/build_native.py --build 179` on that exact final source. Failed or absent gates block release.
2. Create a new private `releases/build179` directory and freeze final source with `release_host179.py freeze`. Preserve all earlier evidence.
3. Confirm work is idle and drafts saved, then quit normally. Run `capture_closed_boundary179.py` for a fresh boundary. Never remove a lease or bypass ownership refusal. Do not start/stop the model server for adapter preparation.
4. Create exact version 1/build 179 release inputs using fresh hashes. Explicitly prepare, review resource delta, build, independently verify signed candidate/archive and install only after coordinated review and required authority.
5. Verify the installed successor, changed workflows, retained history/drafts and ordinary quit/reopen. Record offline inference and unperformed checks truthfully. No automatic downgrade or data rollback after first launch. Installation alone does not authorize status finalization.

Preparation ran only synthetic tests and read retained predecessor artifacts. No freeze, capture, native build, packaging, install, app/model action or original-store operation was performed. This adapter preparation grants no installation authority.
