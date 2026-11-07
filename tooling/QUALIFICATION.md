# Fresh source qualification

Run from the final committed checkout:

~~~sh
python3 -B tooling/qualify.py
~~~

The runner executes compaction/recovery, model stabilization, startup diagnostics and build tools, presentation, MCP/skills, Fetch, worktrees, and release input gates in order. It stops on the first failed suite, preserves the failed command and output, and emits an ineligible report. It never invokes a release phase, the installed app, original app stores or a live model.

Each run has an exclusive directory under this checkout's .artifacts. qualification.json binds the final Git commit, the complete flat source namespace, source stability, actual suite commands, process exits, pass/fail counts and separate logs and execution RESULT files. Every suite RESULT retains its actual constituent command records and opaque copies of the unchanged raw reports. Logs, templates and generated fixture scripts referenced by those reports are copied into the current qualification's evidence directory when directly referenced; original execution paths remain plain provenance strings. Old reports never supply fresh pass counts.

The source and Git commit must remain unchanged throughout the run. Source files and retained evidence must be canonical owned regular files, and an existing output directory is refused. Complete current source pins accompany every suite. The host release adapter independently checks the normalized report, execution counts and artifact hashes against its final frozen source.

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
