# Build177 to Build178 successor adapter

Use `release_host178.py`, `capture_closed_boundary178.py`, `qualify178.py`, and `tests/test_release_inputs178.py`. Historical scripts, helper pins, archives, and receipts remain untouched. `RELEASE.md` and `RELEASE177.md` still describe the guarded sequence, with candidate 178 and installed predecessor 177. Production phases must run from the clean integrated `/Users/saleh/Documents/Noiee/project`, never a development worktree.

## Installed predecessor evidence

The correct stage is `/Users/saleh/Library/Application Support/Saleh Uncensored Release Staging/Noiee177-52c865rb`, not the failed `Noiee177-nho0m98b`. Retained files were read and hashed when preparing this adapter:

- Source commit: `77e04bee3d2078e4f9fbdbfc14e438a257a9fd64`.
- `source-manifest.json`: `b1fccbdeac3fc5ff43a08b9766b714677c2e00ebbfa6556d938b9547224b1a73`.
- `candidate-bundle-manifest.json`: `e5c8a0143afc53987da30cdbf91f0ec79309d60b6c63acf60800c115e66da924`.
- `candidate-receipt.json`: `c4cd3e64298254aaf9502a9506efdbecf8b014ab117a8b1835aedbdad9212dcc`.
- Signed executable: `a329494dca3ae935d9fc61c208b9cc0baa85b53bd60449e279ebe88da48529c2`.
- `installation.json`: `f31e0cc2340ee6d64bd6a46ebb1bea45eeec2385de55d66ac9ee720b0a2f784c`.

Additional retained evidence under `/Users/saleh/Documents/Noiee/releases/build177`:

- `independent-install-audit-20261109T0456Z.json`: `e470ed729e71a128ca7c845e5ce937d65f2199d7d3868966faf4e7f9aad28ed7`.
- `installation-startup-verification-20261109T0458Z.json`: `9515bfc573f11a019e7ce7b1f7839e28e4c18c7f97936a87c99439846f5b29ad`.

Those receipts verify installation, backup integrity and startup, not full native workflow acceptance. They recorded the app left open and LM Studio offline. They are historical evidence, not a fresh closed boundary; no current data-store baseline is inferred. STATUS.json remains unchanged.

## Guards and qualification

All host/capture guard functions are preserved apart from successor identities. Synthetic tests compare function ASTs to Build177. Signing identity, pinned helpers and Node runtime, immutable Fetch payloads, original stores, dependency snapshot, ownership closure, fresh two-observation boundary, exact backup, resource manifests, guarded rename and rollback rules are unchanged.

Intentional qualification coverage increases:

- Model suite retains local-models, coding-model, generated model-picker browser fixture, coding-model-guards, model-stabilization and separate routing checks. Its Node test command additionally requires `source/agent-cancel-check.mjs`, `source/agent-stream-check.mjs`, and `source/agent-usage-check.mjs`. TAP counts remain actual dynamic execution counts.
- Presentation retains presentation/workbench, coding-result-state and coding-parity. It additionally runs `source/coding-ui-check.mjs` without subset flags, covering full Tasks lifecycle, worktrees, scheduling, reviewed Git, history/drafts, terminal and Stop fences. Exit zero and exactly one unchanged full `PASS coding UI:` completion marker are mandatory. This contributes **one completed full-suite scenario**, not an invented assertion count.
- Existing execution budgets remain 900 seconds per command and 1200 seconds per aggregate suite. The full Coding UI run is expected to take approximately four minutes.
- All other required suites and prior fixture assertions remain unchanged. The release-input suite now runs 50 synthetic tests, including exact predecessor pins, unchanged guards, script inventory, and full-UI marker failures. These tests do not run any release phase or access live stores.

## Next coordinated release steps

1. Independently review and integrate app fixes, fixture updates and this adapter; commit and stop editing. Run full `python3 -B tooling/qualify178.py` and `python3 -B tooling/build_native.py --build 178` on that exact source. Missing or failed gates block release.
2. Create a new private `releases/build178` directory and freeze final source with `release_host178.py freeze`. Preserve all earlier receipts.
3. Verify real work is idle and drafts saved, then quit Noiee normally. Capture a fresh boundary with `capture_closed_boundary178.py`. Never remove a lease or bypass an ownership refusal. Do not start or stop the model server for this adapter.
4. Create exact version 1/build 178 release inputs with fresh hashes. Explicitly prepare, review resource delta, build, independently verify signed candidate/archive, and install only after the coordinated release gates pass.
5. Verify installed Build178, changed workflows, retained history/drafts and normal quit/reopen. Report offline inference or other unperformed checks truthfully. No automatic downgrade/data rollback after first launch.

Adapter preparation ran only synthetic tests; no freeze, capture, native build, packaging, install, app/model action or store mutation was performed.
