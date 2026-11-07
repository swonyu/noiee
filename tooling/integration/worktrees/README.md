# Preserved worktree integration checks

Run from the repository root:

```sh
/usr/bin/python3 -B tooling/integration/worktrees/run.py
```

The default source is this checkout's `source` directory. To qualify another checkout explicitly:

```sh
/usr/bin/python3 -B tooling/integration/worktrees/run.py --source /Users/saleh/Documents/Noiee/project/source
```

`--output` accepts a new directory under the selected checkout's `.artifacts`. Its parent must already exist. If omitted, the runner creates an exclusive `worktrees-*` directory there. `--node` and `--python` select installed runtimes; the runner never installs dependencies. Node uses `--preserve-symlinks` so a checkout's existing dependency link remains its module-resolution anchor.

Every run uses a fresh private `~/Library/Caches/NoieeWorktreeChecks-*` directory for generated fixtures and temporary files. Reports and logs stay under `.artifacts`. Generated fixtures are retained for investigation; the runner does not remove another run's data or overwrite an existing report.

## Exactly what the 147 checks cover

| Suite | Cases | Evidence |
|---|---:|---|
| `consumerV3` | 77 | The selected source's signed-map consumer and lifecycle fences, using generated identities, projects, ledgers and maps. Existing dependency injection replaces native reads. |
| `mapProducerPure` | 59 | The unchanged, disabled historical producer's pure map validation against generated observations and pinned saved closed copies. |
| `authenticMap` | 11 | Read-only reproduction of the authentic bundled static map from exact saved observation/review evidence. |

The 59 and 11 historical checks require the exact pinned saved evidence archives named in the reviewed scripts. These archives are intentionally not copied into the repository. The adapter is portable between source checkouts; historical evidence remains an explicit machine-local prerequisite. Missing or changed evidence fails the run. It is never replaced with synthetic evidence and reported as authentic.

These checks do not authenticate the live original store or current boot, activate a map, execute native helpers, start Codex or a model, run Git, or make network connections. The pure and authentic scripts retain their audit hooks. The consumer retains its subprocess/network/fetch/original-store guards. Some consumer cases deliberately exercise configured Files authority only inside generated fixture directories.

## Provenance and reporting

`provenance.json` pins all four vendored helpers and records each path-only adaptation. The runner reverses those declared adaptations and verifies that the result is byte-identical to the reviewed original helper. The producer and the 59-case pure script are unchanged byte for byte. `legacy-provenance.json` retains the preceding copy lineage.

The runner pins every regular top-level source file before execution, verifies the same contents and modes afterward, and retains per-suite commands, logs, results, receipts and hashes. Existing reviewed helper files are observed before/after when present; they are never mutation targets. A failed subprocess, missing proof, changed source, changed helper or incorrect case count yields a nonzero result with retained evidence.

`aggregate.json` separates the three suites and states their limits. The last stdout JSON object includes normalized `name`, `exitCode`, `passed`, `failed`, `log`, `result` and `scope` fields for a release aggregator. A green 147-case result establishes this bounded scope only; native user workflows and live successor admission remain separate acceptance gates.
