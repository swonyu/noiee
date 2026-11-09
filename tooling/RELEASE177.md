# Build176 to Build177 fix release

This is a new successor adapter. Historical release_host.py, capture_closed_boundary.py, qualify.py, Build176 receipts, and earlier archives remain unchanged.

Use release_host177.py, capture_closed_boundary177.py, qualify177.py and test_release_inputs177.py. The guarded process and verification requirements in RELEASE.md apply, with Build177 as candidate and accepted Build176 as predecessor. Run production phases only from the clean integrated /Users/saleh/Documents/Noiee/project checkout. No guard is disabled for development worktrees.

The predecessor is Noiee176-0exv6ti5 under the existing Release Staging directory. Its exact source, bundle and package manifests are pinned in the adapter. Capture also pins its executable. The signing identity, immutable Fetch payloads, data stores, dependency snapshot, native owner closure, exact backup, resource-manifest checks, and guarded rename transaction are unchanged.

## Sequence

1. Independently review fixes and this adapter, integrate and commit, then stop editing. Run python3 -B tooling/qualify177.py and python3 -B tooling/build_native.py --build 177 against that exact source. Required failed or absent suites block installation.
2. Create a new private releases/build177 directory. Freeze source with release_host177.py freeze and retain new evidence without overwriting old receipts.
3. Inspect actual running work; quit Noiee normally only when idle and drafts are saved. Run capture_closed_boundary177.py to obtain a fresh two-observation closed boundary. Never remove a lease or bypass an ownership refusal.
4. Create exact version1/build177 release-input.json referencing the source freeze, current boundary, native build and qualification with actual hashes.
5. Invoke prepare, review prepared.json and resource delta; invoke build, independently review signed candidate and archive; invoke install only after every gate passes. Each phase is explicit and writes exclusive artifacts.
6. Launch and verify actual Build177, changed workflows, retained history/drafts and normal quit/reopen. Generated fixtures are not native acceptance. Record any unverified model/runtime work truthfully.

The installer does not change STATUS.json. Preserve the current accepted Build176 status before any separately reviewed finalization. Installation alone is not successful native acceptance. No automatic downgrade or data rollback is permitted after first launch.
