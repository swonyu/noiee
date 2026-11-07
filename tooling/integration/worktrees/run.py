"""Run the preserved 77 + 59 + 11 worktree checks against an explicit checkout.
Only generated fixtures are written. Historical evidence is read-only.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SCOPE = ("77 generated cases exercise the selected source's V3 consumer; "
         "59 unchanged pure cases exercise the disabled historical producer; "
         "11 read-only cases reproduce the authentic bundled static map from "
         "pinned saved evidence. No live original-store authentication, native "
         "helper execution, current-boot qualification or activation is claimed.")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def ref(path):
    return {"path": str(path), "sha256": sha(path.read_bytes())}


def save(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    path.chmod(0o600)


def snapshot(source):
    result = {}
    for path in sorted(source.iterdir()):
        info = path.lstat()
        if stat.S_ISREG(info.st_mode):
            raw = path.read_bytes()
            result[path.name] = {"sha256": sha(raw), "size": len(raw),
                                 "mode": stat.S_IMODE(info.st_mode)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=HERE.parents[2] / "source")
    parser.add_argument("--output", type=Path,
                        help="Fresh directory under the selected checkout's .artifacts")
    parser.add_argument("--node", default=shutil.which("node") or "/opt/homebrew/bin/node")
    parser.add_argument("--python", default=sys.executable)
    args = parser.parse_args()
    source = args.source.expanduser().resolve(strict=True)
    if not source.is_dir() or not (source / "managed-worktrees.mjs").is_file():
        raise ValueError("Select a source directory containing managed-worktrees.mjs")
    artifact_root = source.parent / ".artifacts"
    if artifact_root.is_symlink():
        raise ValueError("Artifact root must not be a symlink")
    artifact_root.mkdir(mode=0o700, exist_ok=True)
    artifact_root = artifact_root.resolve(strict=True)
    if args.output:
        output = args.output.expanduser().absolute()
        if output == artifact_root or artifact_root not in output.parents:
            raise ValueError("Output must be a new child of the selected checkout's .artifacts")
        if output.parent.resolve(strict=True) != output.parent or output.exists() or output.is_symlink():
            raise ValueError("Output must be a fresh canonical directory")
        output.mkdir(mode=0o700)
    else:
        output = Path(tempfile.mkdtemp(prefix="worktrees-", dir=artifact_root))
    cache_root = (Path.home() / "Library" / "Caches").resolve(strict=True)
    if cache_root != Path.home() / "Library" / "Caches":
        raise ValueError("The generated Caches root must be canonical")
    cache = Path(tempfile.mkdtemp(prefix="NoieeWorktreeChecks-", dir=cache_root))
    (cache / "tmp").mkdir(mode=0o700)
    run_log = output / "run.log"
    run_log.touch(mode=0o600, exist_ok=False)

    def emit(value):
        line = value if isinstance(value, str) else json.dumps(value)
        with run_log.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")
        print(line, flush=True)

    manifest = json.loads((HERE / "provenance.json").read_text())
    before = snapshot(source)
    pins = {name: item["sha256"] for name, item in before.items()}
    originals = {}
    suites = []
    error = None
    command = [sys.executable, "-B", str(Path(__file__).resolve()), *sys.argv[1:]]
    emit({"name": "worktrees", "sourceDirectory": str(source),
          "fixtureDirectory": str(cache), "resultDirectory": str(output)})
    try:
        for item in manifest["files"]:
            local = HERE / item["file"]
            if sha(local.read_bytes()) != item["sha256"]:
                raise ValueError("Vendored test provenance changed: " + item["file"])
            reconstructed = local.read_text()
            for adaptation in reversed(item["adaptations"]):
                if reconstructed.count(adaptation["new"]) != 1:
                    raise ValueError("Declared path adaptation is not unique")
                reconstructed = reconstructed.replace(adaptation["new"], adaptation["old"], 1)
            if sha(reconstructed.encode()) != item["reviewedOriginal"]["sha256"]:
                raise ValueError("Changes beyond declared path adaptations: " + item["file"])
            # A source archive can be absent on another checkout. When present,
            # observe it without making it a runtime copy source or mutating it.
            original = Path(item["reviewedOriginal"]["path"])
            if original.is_file():
                observed = sha(original.read_bytes())
                if observed != item["reviewedOriginal"]["sha256"]:
                    raise ValueError("Reviewed original test changed: " + item["file"])
                originals[str(original)] = observed
        historical = manifest["legacyProvenance"]
        if sha((HERE / historical["file"]).read_bytes()) != historical["sha256"]:
            raise ValueError("Legacy provenance record changed")
        env = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME") if key in os.environ}
        env.update(PATH="/opt/homebrew/bin:/usr/bin:/bin", LANG="C",
                   TMPDIR=str(cache / "tmp") + "/", PYTHONDONTWRITEBYTECODE="1",
                   NOIEE_WORKTREE_FIXTURE_ROOT=str(cache),
                   NOIEE_WORKTREE_SOURCE=str(source))
        specs = [
            ("consumerV3", [args.node, "--preserve-symlinks", str(HERE / "check-v3-view.mjs")], 77),
            ("mapProducerPure", [args.python, "-B", str(HERE / "test_map_pure.py")], 59),
            ("authenticMap", [args.python, "-B", str(HERE / "check-authentic-map.py")], 11),
        ]
        for name, suite_command, expected in specs:
            emit("START " + name)
            started = datetime.datetime.now(datetime.timezone.utc).isoformat()
            log = output / (name + ".log")
            details, suite_error = None, None
            with log.open("xb") as stream:
                try:
                    process = subprocess.run(suite_command, cwd=HERE, env=env,
                                             stdout=stream, stderr=subprocess.STDOUT, timeout=300)
                    exit_code = process.returncode
                except subprocess.TimeoutExpired:
                    exit_code, suite_error = 124, "Bounded suite timed out after 300 seconds."
            log.chmod(0o600)
            after = snapshot(source)
            if exit_code == 0:
                try:
                    details = json.loads((cache / "check-result.json").read_text()
                                         if name == "consumerV3" else log.read_text())
                    if details["passed"] != expected or details["failed"] != 0:
                        raise ValueError("Preserved expected case count or result did not match")
                except Exception as exc:
                    exit_code, suite_error = 1, str(exc)
            suite = {"name": name, "sourceDirectory": str(source), "sourcePins": pins,
                     "sourceUnchanged": after == before, "exitCode": exit_code,
                     "passed": details.get("passed", 0) if details else 0,
                     "failed": max(details.get("failed", 0), int(exit_code != 0)) if details else 1,
                     "expected": expected, "command": suite_command, "startedUTC": started,
                     "completedUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                     "log": ref(log), "scope": SCOPE}
            if suite_error:
                suite["error"] = suite_error
            details_path = output / (name + "-result.json")
            save(details_path, details if details is not None else
                 {"name": name, "exitCode": exit_code, "error": suite_error or "See retained suite log."})
            suite["result"] = ref(details_path)
            receipt_path = output / (name + "-receipt.json")
            save(receipt_path, suite)
            suites.append({"receipt": ref(receipt_path), **suite})
            emit({"name": name, "exitCode": exit_code, "passed": suite["passed"],
                  "failed": suite["failed"], "sourceUnchanged": suite["sourceUnchanged"]})
            if after != before:
                raise ValueError("Selected source changed during verification")
        for path, pin in originals.items():
            if sha(Path(path).read_bytes()) != pin:
                raise ValueError("Reviewed original helper changed during verification")
        for item in manifest["files"]:
            if sha((HERE / item["file"]).read_bytes()) != item["sha256"]:
                raise ValueError("Vendored helper changed during verification")
    except Exception as exc:
        error = str(exc)
        emit({"adapterError": error})

    unchanged = snapshot(source) == before
    green = not error and unchanged and len(suites) == 3 and all(
        row["exitCode"] == 0 and row["failed"] == 0 and row["sourceUnchanged"] for row in suites)
    passed = sum(row["passed"] for row in suites)
    failed = sum(row["failed"] for row in suites) + int(bool(error))
    if not green and failed == 0:
        failed = 1
    emit({"exitCode": 0 if green else 1, "passed": passed, "failed": failed,
          "sourceUnchanged": unchanged})
    report = {"schema": 1, "name": "worktrees", "sourceDirectory": str(source),
              "sourcePins": pins, "sourceSnapshot": before, "sourceUnchanged": unchanged,
              "exitCode": 0 if green else 1, "passed": passed, "failed": failed,
              "command": command, "log": ref(run_log), "scope": SCOPE,
              "runner": ref(Path(__file__).resolve()), "provenance": ref(HERE / "provenance.json"),
              "fixtureDirectory": str(cache), "resultDirectory": str(output),
              "assertionsChanged": False, "observedOriginalHelperPins": originals,
              "testSources": {item["file"]: item["sha256"] for item in manifest["files"]},
              "suites": suites, "error": error,
              "completedUTC": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    result_path = output / "aggregate.json"
    save(result_path, report)
    print(json.dumps({"name": "worktrees", "exitCode": report["exitCode"],
                      "passed": passed, "failed": failed, "log": ref(run_log),
                      "result": ref(result_path), "scope": SCOPE}), flush=True)
    return report["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
