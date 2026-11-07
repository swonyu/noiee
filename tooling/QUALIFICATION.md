# Fresh source qualification

Run from the final committed checkout:

~~~sh
python3 -B tooling/qualify.py
~~~

The runner executes compaction/recovery, model stabilization, startup diagnostics and build tools, presentation, saved Tasks catalog, Goals, submission origins, MCP/skills, Fetch, worktrees, and release input gates in order. It stops on the first failed suite, preserves the failed command and output, and emits an ineligible report. It never invokes a release phase, the installed app, original app stores or a live model.

Each run has an exclusive directory under this checkout's .artifacts. qualification.json binds the final Git commit, the complete flat source namespace, source stability, actual suite commands, process exits, pass/fail counts and separate logs and execution RESULT files. Every suite RESULT retains its actual constituent command records and opaque copies of the unchanged raw reports. Logs, templates and generated fixture scripts referenced by those reports are copied into the current qualification's evidence directory when directly referenced; original execution paths remain plain provenance strings. Old reports never supply fresh pass counts.

The source and Git commit must remain unchanged throughout the run. Source files and retained evidence must be canonical owned regular files, and an existing output directory is refused. The exact installed Chrome launcher named by browser-fixture receipts is also read and copied as dependency evidence after checking its recorded digest; its observed hard links do not relax the single-link rule for source or retained artifacts. Complete current source pins accompany every suite. The host release adapter independently checks the normalized report, execution counts and artifact hashes against its final frozen source.

## Model browser coverage

The model suite enables MODEL_PICKER_BROWSER=1 and refuses any TAP skip, cancellation or todo. It preserves the existing browser assertions while supplying two missing current fixture inputs: a 65,536-token loaded-context field in fake model inventory rows, and the real context-compaction.js asset in the intercepted page resource set. It copies the current source test into a fresh private Caches fixture directory, records both source and generated digests, and routes every page request and native call to the original fakes. Current product source is never edited. It then runs all twenty in-memory model-routing cases.

The first unadapted browser trial was retained as a failure: it timed out at Send because those fixture inputs had not been updated with the product. That result is not counted as a pass. This adapter must fail if either exact adaptation anchor changes; new functional differences need review.

## Focused trials and input checks

~~~sh
python3 -B tooling/qualify.py --suite model-stabilization
python3 -B tooling/tests/test_qualify.py
~~~

A focused suite RESULT is useful for diagnosis but is not a complete release qualification. --project may select another committed checkout for a helper-development trial. The result always records that checkout's exact source directory and commit. --output accepts only a new canonical child of the selected checkout's .artifacts.

The unit checks use generated files and short child processes. They verify that missing/duplicated TAP summaries, skipped browser tests, failed commands, wrong artifact digests, linked source files, stale report receipts and unsafe output paths fail instead of becoming passing qualification evidence.

Generated fixture state remains under private Caches directories where the existing adapters require it. No generated state is treated as user data or installed acceptance. Native application compilation, signed packaging, guarded installation and live/cold-reopen acceptance are separate release gates owned by the release operator.


Python workers launch the interpreter resolved from the actual `sys.orig_argv[0]` invocation identity. On macOS framework builds, `sys.executable` can name a launcher that execs a different Python.app binary; using that launcher would make an otherwise passing child report a different command. The executor keeps exact command equality and rejects a genuinely different executable or argument list. It never rewrites an older execution receipt to make its command match.

## Catalog and Goal review coverage

The required catalog family runs generated owner/history fixtures against the current owner manager, plus the actual list controller and exact Goal-result navigation functions with generated asynchronous replies and a fresh browser DOM. It checks bounded read overlap, retained serial ownership, failure/cancellation drain, progress without authority, progressive verified pages, incomplete/late replies and exact-turn focus without dispatch. Backend and UI commands both report strict unique assertion names and actual counts. These fixture timings do not establish native cold-start latency.

Goal browser coverage includes the responsive inspector, preserved editor text and focus, explicit continuation-history expansion and exact acknowledged-turn callback binding. Installed window geometry, accessibility and cold history loading require separate acceptance.

## Goal and submission coverage

The required Goals family runs the bounded ledger/admission fixtures and the real Tasks page against a fake native bridge. It checks explicit continuation, attempt limits, retained uncertainty, owner/project/model scope, pause/resume, manual completion evidence, cold storage reads, editor/composer preservation, stale and mis-scoped replies, unavailable capabilities and failed draft persistence. It reports actual unique assertion counts.

The submission-origin family runs the ordinary run backend and browser fixtures. It checks exact digest/admission binding, legacy receipt reads without migration, bounded input observations, IME/repeat/default submission behavior, Retry and reload without resend. Generated or scripted browser events remain eligible under existing guards; observed trust never replaces authorization.

These suites do not establish native accessibility, real macOS IME behavior, real-model quality or the installed native Goal restoration fence. A disposable installed-runtime protocol probe and installed-app acceptance are separately identified evidence; they must not be folded into generated pass counts.

## Build175 installed-runtime Goal fence

A separate disposable protocol qualification exercised the exact installed Codex runtime (0.167.0-alpha.3.2, SHA256 a636331ed87605efc4cf84028ac2884a75363f9d10ead63cffb57ea0016d486e). It used new test homes/projects, a read-only sandbox and an inert loopback provider. The enabled positive control restored an active native Goal and started one turn/provider request. With the feature disabled, cold resume started no turn during two independent eight-second observations. One explicitly requested text-only turn completed, followed by an eight-second observation with no additional continuation. Re-enabling the getter in a later process confirmed that the original active Goal was still retained.

The disabled native Goal getter returns RPC -32600, "goals feature is disabled". This is evidence of feature disablement under the qualified runtime, not evidence of absent native Goal state. Noiee requires the exact runtime pin, verified disabled configuration, disabled launch/thread overrides and only the recognized disabled-feature response or an explicit null result. Other errors or uncertain configuration hold continuation.

The 38 positive checks and retained initial refusal are separate from the generated suite count. Their manifest is /Users/saleh/Documents/Noiee/updates/build175/runtime-goal-fence/QUALIFICATION.json, SHA256 593df160589573432afdb6f07d89359387c32b8f654eb053d1d25d8be4b7aa3e. It binds runner source, raw protocol, fake-provider traffic, command, environment, process exits and receipt hashes. This is bounded observed evidence on that binary; it does not prove other runtime versions, real model quality or native UI behavior. A runtime change requires renewed compatibility and Goal-fence qualification.
