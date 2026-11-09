# Fail-closed reproduction correction

The measured experiment at commit `6ae6b4af2d5e479fcec7dd7c543ca0193cc023dd` remains valid: every real staging/import/conversion step succeeded, and the independent reviewer reproduced all eight conversion JSON outputs exactly using the retained isolated venv. No actual partial/failing conversion was reclassified as success in those observations.

Review found a **future reproduction error-signaling defect**: the staging and continuation scripts returned normally after failed subprocesses, allowing shell exit 0; the child also printed a partial/non-success Docling observation without a failing exit. The corrected runners now:

- Return exit 1 immediately for a failed stage, venv, install, network/import probe, Office generation or conversion; later stages do not run.
- Return exit 1 if the disk/cancellation monitor is set at completion.
- Return exit 2 from the conversion child for every Docling status other than `success`. Partial observations remain explicitly labeled and retained for diagnosis; they do not permit continuation.
- Return exit 0 only for the successful path.

The original `receipt.json`, observations, configuration, wheel/inventory/probe evidence and historical `manifest.json` are **unchanged**. Exact measured runner/test source bytes are preserved as inert `.py.txt` snapshots under `measured_source/`, with the mapping and hashes in `runner_correction.json`. The historic manifest now resolves those changed source entries to their measured snapshots rather than falsely binding old observations to corrected code. The corrected code has its own hashes in that sidecar.

Validation: 55 offline tests pass on both Python 3.15.2 and the exact Python 3.14.8. New injected-outcome tests cover every failed stage and every failed continuation position, CLI nonzero propagation, successful paths, and success/partial/failure/skipped/pending/unknown conversion statuses. The child-status tests use synthetic injected Docling objects and are not additional real conversion measurements. No downloads, installations, model/server/app actions or unnecessary full conversion rerun were performed for this correction.
