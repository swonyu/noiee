#!/usr/bin/env python3
"""Run fresh isolated Noiee checks and retain their exact execution evidence.

The default runs every required suite in sequence. --suite is also useful for a
focused, non-release trial. No installed app, real inference, original data,
runtime installation, release phase, signing or UI automation is invoked.
"""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

SELF = Path(__file__).resolve()
DEFAULT_PROJECT = SELF.parents[1]
CHROME_LAUNCHER = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
SUITES = ("compaction-recovery", "model-stabilization", "startup-diagnostics",
          "presentation", "mcp-skills", "fetch", "worktrees", "release-inputs")
SCOPES = {
    "release-inputs": "Generated release-adapter input gates only. No release phase, app, model, installed bundle or original data is opened.",
    "compaction-recovery": "Generated compaction state, CAS, races, browser and extracted native recovery fixtures. Fake inference and dialogs only.",
    "model-stabilization": "Generated inventories, in-memory model/engine routing and real headless browser pages with every request and native call faked. No live model.",
    "startup-diagnostics": "Compiled current startup diagnostics with generated processes, configuration and sockets; generated build and backup-inventory fixtures.",
    "presentation": "Current Chat/Tasks rendering, shared command palette, tool-authority labels and delegated-result views in fresh headless browsers, plus generated receipt/state cases. Requests and native calls are faked; no inference or original browser profile.",
    "mcp-skills": "Fresh generated MCP lifecycle/recovery and project-skills native, Agent and UI checks. Fake transports; no original stores.",
    "fetch": "Dependent installer, native, guard, durable, UI, admission and recovery fixtures. Only generated bundled payload copies; no external install.",
    "worktrees": "Generated current V3 consumer cases, unchanged disabled historical map-producer pure cases, and read-only static-map reproduction. No current-boot admission claim."
}

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_regular(path, limit=32 * 1024 * 1024):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts
            and path.resolve(strict=True) == path, "Noncanonical file: " + str(path))
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and before.st_uid == os.getuid() and before.st_size <= limit,
            "Unsafe or oversized fixture/evidence file: " + str(path))
    data = path.read_bytes()
    after = path.lstat()
    keys = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid",
            "st_nlink", "st_mtime_ns", "st_ctime_ns")
    require(len(data) == before.st_size and all(
        getattr(before, key) == getattr(after, key) for key in keys),
        "File changed during read: " + str(path))
    return data

def read_browser_runtime(path):
    # Chrome ships a multiply linked launcher on this host. Keep that observed
    # dependency exception separate from the single-link source/artifact policy.
    path = Path(path)
    require(path == CHROME_LAUNCHER and path.resolve(strict=True) == path,
            "Only the exact browser fixture launcher may use this read")
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid in (0, os.getuid())
            and 0 < before.st_nlink and before.st_size <= 8 * 1024 * 1024,
            "Unsafe browser launcher")
    data = path.read_bytes()
    after = path.lstat()
    keys = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid", "st_nlink", "st_mtime_ns", "st_ctime_ns")
    require(len(data) == before.st_size and all(getattr(before, key) == getattr(after, key) for key in keys),
            "Browser launcher changed during evidence capture")
    return data

def ref(path):
    data = read_regular(path)
    return {"path": str(path), "sha256": digest(data)}

def save_new(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    Path(path).chmod(0o600)

def source_pins(project):
    source = project / "source"
    require(source.resolve(strict=True) == source, "Source directory must be canonical")
    pins = {}
    for path in sorted(source.iterdir()):
        if path.name == "node_modules":
            continue
        pins[path.name] = digest(read_regular(path))
    require(pins and "app.js" in pins, "Expected the flat Noiee source namespace")
    return pins

def git_commit(project):
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    top = subprocess.check_output(
        ["/usr/bin/git", "-C", str(project), "rev-parse", "--show-toplevel"],
        text=True, env=env, timeout=20).strip()
    require(top == str(project), "Project must be the Git checkout root")
    commit = subprocess.check_output(
        ["/usr/bin/git", "-C", str(project), "rev-parse", "HEAD"],
        text=True, env=env, timeout=20).strip()
    status = subprocess.check_output(
        ["/usr/bin/git", "-C", str(project), "status", "--porcelain=v1",
         "--untracked-files=all"], text=True, env=env, timeout=20).strip()
    require(not status, "Commit the selected checkout before qualification")
    require(re.fullmatch("[0-9a-f]{40}", commit), "Expected a Git commit")
    return commit

def invocation():
    # orig_argv preserves the actual -B option and executable spelling.
    return list(sys.orig_argv)

def launched_interpreter():
    # macOS framework sys.executable may name a launcher that execs Python.app.
    # Launch the actual invocation identity so a child's recorded argv stays exact.
    original = invocation()
    require(original and isinstance(original[0], str) and original[0],
            "Actual interpreter invocation is unavailable")
    name = original[0]
    located = name if os.path.isabs(name) or os.sep in name else shutil.which(name)
    require(located, "Actual invocation interpreter could not be resolved")
    path = Path(located).resolve(strict=True)
    require(path.is_file() and os.access(path, os.X_OK),
            "Actual invocation interpreter is not executable")
    return str(path)

def verify_command(recorded, executed):
    require(recorded == executed, "Recorded command differs from the executed command")

def parse_json_lines(text):
    values = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                values.append(value)
        except ValueError:
            pass
    return values

def tap_counts(text):
    def count(label):
        matches = re.findall(r"^# " + label + r" (\d+)$", text, re.M)
        require(len(matches) == 1, "Missing or ambiguous TAP " + label)
        return int(matches[0])
    values = {key: count(key) for key in
              ("tests", "pass", "fail", "cancelled", "skipped", "todo")}
    require(values["pass"] > 0 and values["fail"] == values["cancelled"]
            == values["skipped"] == values["todo"] == 0
            and values["tests"] == values["pass"],
            "TAP must complete every test with zero failures, cancellations or skips")
    return values["pass"]

def unittest_counts(text):
    matches = re.findall(r"^Ran (\d+) tests? in [^\n]+$", text, re.M)
    require(len(matches) == 1 and int(matches[0]) > 0
            and re.search(r"\nOK\s*$", text)
            and not re.search(r"\b(FAILED|skipped=|expected failures=|unexpected successes=)", text),
            "Expected a complete passing unittest execution")
    return int(matches[0])

def execute(command, log, cwd, env, timeout=900):
    started = utc()
    with log.open("xb") as stream:
        process = subprocess.Popen(command, cwd=cwd, env=env,
                                   stdin=subprocess.DEVNULL, stdout=stream,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Only the fresh fixture process group belongs to this executor.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            code = 124
            stream.write(b"\nQUALIFICATION TIMEOUT: owned fixture group terminated.\n")
    log.chmod(0o600)
    return {"command": command, "exitCode": code, "startedUTC": started,
            "completedUTC": utc(), "log": ref(log)}

class Suite:
    def __init__(self, args, project, output, commit, pins):
        self.args, self.project, self.output = args, project, output
        self.source, self.commit, self.pins = project / "source", commit, pins
        self.rows, self.retained, self.originals = [], [], {}
        self.evidence = output / "evidence"
        self.evidence.mkdir(mode=0o700)
        caches = (Path.home() / "Library/Caches").resolve(strict=True)
        self.cache = Path(tempfile.mkdtemp(prefix="NoieeQualification175-", dir=caches))
        (self.cache / "tmp").mkdir(mode=0o700)
        self.env = {key: os.environ[key] for key in ("HOME", "USER", "LOGNAME") if key in os.environ}
        self.env.update(PATH="/opt/homebrew/bin:/usr/bin:/bin", LANG="C",
                        TMPDIR=str(self.cache / "tmp") + "/",
                        PYTHONDONTWRITEBYTECODE="1")
        self.node = str(Path(args.node).resolve(strict=True))
        self.python = launched_interpreter()
        self.started_ns = time.time_ns()

    def retain(self, path, pin=None):
        path = Path(path)
        runtime = path == CHROME_LAUNCHER
        allowed = runtime or path.is_relative_to(self.project) or (
            path.is_relative_to(Path.home() / "Library/Caches")
            and any(part.startswith(("Noiee", "noiee")) for part in path.parts))
        require(allowed, "Evidence is outside this checkout/generated fixtures: " + str(path))
        require(not runtime or isinstance(pin, str), "Browser runtime evidence requires its observed digest")
        data = read_browser_runtime(path) if runtime else read_regular(path)
        actual = digest(data)
        require(pin is None or actual == pin, "Evidence digest differs: " + str(path))
        key = (str(path), actual)
        if key not in self.originals:
            target = self.evidence / ("%03d-%s-%s" %
                       (len(self.originals) + 1, actual[:12], path.name))
            with target.open("xb") as stream:
                stream.write(data)
            target.chmod(0o600)
            item = {"originalPath": str(path), "retained": ref(target)}
            self.originals[key] = item
            self.retained.append(item)
        return self.originals[key]["retained"]

    def retain_references(self, value):
        if isinstance(value, dict):
            if {"path", "sha256"} <= set(value) <= {"path", "sha256", "bytes"}:
                self.retain(value["path"], value["sha256"])
                return
            if isinstance(value.get("logPath"), str) and isinstance(value.get("logSHA256"), str):
                self.retain(value["logPath"], value["logSHA256"])
            for child in value.values():
                self.retain_references(child)
        elif isinstance(value, list):
            for child in value:
                self.retain_references(child)

    def verify_pins(self, pins):
        require(isinstance(pins, dict) and pins, "Raw source/fixture pins missing")
        for name, expected in pins.items():
            require(isinstance(name, str) and isinstance(expected, str)
                    and re.fullmatch("[0-9a-f]{64}", expected),
                    "Raw source pins must be name/digest pairs")
            path = self.source / name if "/" not in name else self.project / name
            require(path.is_relative_to(self.project) and ".." not in path.parts
                    and digest(read_regular(path)) == expected,
                    "Raw source/fixture pin differs: " + name)

    def raw_report(self, text, keys=("result", "report", "receipt")):
        candidates = []
        for row in parse_json_lines(text):
            for key in keys:
                value = row.get(key)
                if isinstance(value, str):
                    candidates.append((Path(value), row.get("sha256")))
                elif isinstance(value, dict) and {"path", "sha256"} <= set(value):
                    candidates.append((Path(value["path"]), value["sha256"]))
        require(candidates, "Execution did not return a report path")
        path, pin = candidates[-1]
        require(path.is_relative_to(self.project / ".artifacts"),
                "Raw report must be in the current checkout artifacts")
        data = read_regular(path)
        require(path.stat().st_mtime_ns >= self.started_ns,
                "Raw report predates this fresh suite execution")
        require(pin is None or digest(data) == pin, "Returned report digest differs")
        raw = json.loads(data)
        retained = self.retain(path, digest(data))
        for key in ("sourcePins", "sourceHashes"):
            if key in raw:
                self.verify_pins(raw[key])
        if "sourceDirectory" in raw:
            require(raw["sourceDirectory"] == str(self.source), "Raw source directory differs")
        if "source" in raw:
            require(raw["source"] == str(self.source), "Raw source path differs")
        if "sourceUnchanged" in raw:
            require(raw["sourceUnchanged"] is True, "Raw execution changed its source")
        self.retain_references(raw)
        # Preserve nearby raw logs/screenshots unchanged. Their JSON remains opaque:
        # original execution paths are evidence, not rewritten claims.
        require(path.parent != self.project / ".artifacts", "Expected an exclusive raw run directory")
        for sibling in sorted(path.parent.iterdir()):
            if (not sibling.is_symlink() and sibling.is_file()
                    and sibling.suffix in {".json", ".log", ".png", ".txt"}
                    and sibling.stat().st_mtime_ns >= self.started_ns):
                self.retain(sibling)
        return raw, retained

    def case(self, name, command, parser, env=None):
        print("START " + self.args.suite + " / " + name, flush=True)
        before = source_pins(self.project)
        row = {"name": name}
        log = self.output / (name + ".log")
        row.update(execute(command, log, self.project, env or self.env))
        self.rows.append(row)
        try:
            text = read_regular(log).decode("utf-8", errors="replace")
            require(row["exitCode"] == 0, "Fixture command exited " + str(row["exitCode"]))
            passed, extra = parser(text)
            require(type(passed) is int and passed > 0, "Actual positive case count required")
            require(source_pins(self.project) == before == self.pins,
                    "Source changed during fixture command")
            row.update(passed=passed, failed=0, sourceUnchanged=True, **extra)
        except Exception as error:
            row.update(passed=0, failed=1, sourceUnchanged=source_pins(self.project) == before,
                       error=str(error))
            print("FAIL " + name + ": " + str(error), flush=True)
            print(read_regular(log).decode("utf-8", errors="replace")[-8000:], flush=True)
            raise
        print("PASS " + name + ": " + str(row["passed"]), flush=True)

    def aggregate_parser(self, expected, kind):
        def parse(text):
            raw, kept = self.raw_report(text)
            require(raw.get("exitCode") == 0 and raw.get("failed") == 0
                    and raw.get("passed") == expected, "Raw aggregate did not pass its preserved case count")
            children = raw.get("checks", raw.get("rows", raw.get("suites")))
            require(isinstance(children, list) and children, "Raw aggregate execution rows missing")
            for child in children:
                require(child.get("exitCode") == 0 and isinstance(child.get("command"), list),
                        "Raw aggregate has a failed/unrecorded constituent")
                if "qualified" in child:
                    require(child["qualified"] is True, "Raw constituent was not qualified")
                if "failed" in child:
                    require(child["failed"] == 0, "Raw constituent failed")
            if kind != "fetch":
                require(sum(child.get("passed", 0) for child in children) == expected,
                        "Raw constituent count does not equal aggregate")
            return expected, {"rawResult": kept, "preservedExpected": expected}
        return parse

    def model_fixture(self):
        original = self.source / "model-picker-ui-check.mjs"
        raw = read_regular(original).decode()
        adaptations = [
            ("label: id, loaded: true", "label: id, contextLength: 65536, loaded: true",
             "Provide the actual loaded context field required by the current request budget guard."),
            ("new Set(['model-policy.js'", "new Set(['context-compaction.js','model-policy.js'",
             "Serve the real compaction helper now required by the unchanged shipped Chat page.")
        ]
        generated = raw
        for old, new, reason in adaptations:
            require(generated.count(old) == 1, "Model fixture adaptation anchor changed: " + old)
            generated = generated.replace(old, new)
        path = self.cache / original.name
        path.write_text(generated)
        path.chmod(0o600)
        (self.cache / "node_modules").symlink_to(self.source / "node_modules", target_is_directory=True)
        self.fixture = {
            "originalSource": "source/" + original.name,
            "originalSHA256": digest(raw.encode()),
            "generated": self.retain(path),
            "changes": [reason for _, _, reason in adaptations],
            "assertionsChanged": False
        }
        return path

    def run(self):
        name = self.args.suite
        py = lambda path: [self.python, "-B", str(self.project / path)]
        node = lambda path: [self.node, "--preserve-symlinks", str(self.project / path)]
        if name == "compaction-recovery":
            self.case("compaction", py("checks/compaction/run-suite.py") + ["--node", self.node],
                      self.aggregate_parser(151, "compaction"))
        elif name == "model-stabilization":
            fixture = self.model_fixture()
            scripts = [self.source / "local-models-check.mjs", self.source / "coding-model-check.mjs",
                       fixture, self.source / "coding-model-guards-check.mjs",
                       self.source / "model-stabilization-check.mjs"]
            env = {**self.env, "MODEL_PICKER_BROWSER": "1", "MODEL_PICKER_SOURCE": str(self.source)}
            command = [self.node, "--preserve-symlinks", "--test", "--test-reporter=tap", *map(str, scripts)]
            self.case("model-focused-and-browser", command, lambda text: (
                tap_counts(text), {"environment": {"MODEL_PICKER_BROWSER": "1",
                                                  "MODEL_PICKER_SOURCE": str(self.source)}}), env)
            def routing(text):
                counts = re.findall(r"^PASS (\d+) in-memory model-routing checks; no sockets or real inference\.$", text, re.M)
                require(len(counts) == 1 and int(counts[0]) == 20, "Routing did not complete all 20 cases")
                return int(counts[0]), {}
            self.case("model-routing", node("source/model-routing-check.mjs"), routing)
        elif name == "startup-diagnostics":
            def startup(text):
                raw, kept = self.raw_report(text)
                count = raw.get("result")
                require(raw.get("compilerExit") == raw.get("exitCode") == 0
                        and isinstance(count, dict) and count.get("failed") == 0
                        and type(count.get("passed")) is int and count["passed"] > 0,
                        "Startup compilation/fixture did not pass")
                return count["passed"], {"rawResult": kept}
            self.case("startup", py("tooling/check_startup.py"), startup)
            self.case("build-tools", [self.python, "-B", "-m", "unittest", "discover", "-s",
                      "tooling/tests", "-p", "test_build_tools.py", "-v"],
                      lambda text: (unittest_counts(text), {}))
        elif name == "presentation":
            def presentation(text):
                raw, kept = self.raw_report(text)
                count = raw.get("checks")
                require(raw.get("status") == "passed" and type(count) is int and count > 0
                        and isinstance(raw.get("names"), list)
                        and len(raw["names"]) == len(set(raw["names"])) == count,
                        "Presentation assertions did not all complete")
                return count, {"rawResult": kept}
            self.case("presentation", node("tests/presentation-check.mjs"), presentation)
            self.case("workbench", node("tests/workbench-check.mjs"), presentation)
            self.case("coding-result-state", [self.node, "--preserve-symlinks", "--test",
                      "--test-reporter=tap", str(self.source / "coding-result-check.mjs")],
                      lambda text: (tap_counts(text), {}))
            def coding_parity(text):
                rows = [row for row in parse_json_lines(text) if row.get("name") == "coding-ui-parity"]
                require(len(rows) == 1, "Expected one fresh Coding parity result")
                row = rows[0]
                checks = row.get("checks")
                require(row.get("schemaVersion") == 1 and row.get("passed") == 26
                        and row.get("failed") == 0 and isinstance(checks, list)
                        and all(isinstance(value, str) and value for value in checks)
                        and len(checks) == len(set(checks)) == 26,
                        "Coding parity assertions did not all complete")
                return len(checks), {"assertions": checks, "preservedExpected": 26}
            self.case("coding-parity", node("source/coding-ui-check.mjs") + ["--coding-parity-only"],
                      coding_parity)
        elif name == "release-inputs":
            self.case("release-inputs", [self.python, "-B", "-m", "unittest", "discover", "-s",
                      "tooling/tests", "-p", "test_release_inputs.py", "-v"],
                      lambda text: (unittest_counts(text), {}))
        elif name in {"mcp-skills", "fetch", "worktrees"}:
            expected = {"mcp-skills": 77, "fetch": 74, "worktrees": 147}[name]
            command = py("tooling/integration/" + name + "/run.py")
            if name == "worktrees":
                command += ["--source", str(self.source), "--node", self.node, "--python", self.python]
            self.case(name, command, self.aggregate_parser(expected, name))
        else:
            raise RuntimeError("Unknown suite")


def create_output(project, requested, prefix):
    artifacts = project / ".artifacts"
    require(not artifacts.is_symlink(), "Artifact root must not be linked")
    artifacts.mkdir(mode=0o700, exist_ok=True)
    require(artifacts.resolve(strict=True) == artifacts, "Artifact root must be canonical")
    if requested:
        path = Path(requested).absolute()
        require(path != artifacts and path.is_relative_to(artifacts) and ".." not in path.parts,
                "Output must be a new child of this checkout's .artifacts")
        require(path.parent.resolve(strict=True) == path.parent
                and not path.exists() and not path.is_symlink(),
                "Output must be fresh and canonical")
        path.mkdir(mode=0o700)
        return path
    name = prefix + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    path = artifacts / name
    path.mkdir(mode=0o700)
    return path

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=DEFAULT_PROJECT,
                        help="Committed checkout; default is this script's checkout")
    parser.add_argument("--suite", choices=SUITES, help="Run one fresh suite; not a full release qualification")
    parser.add_argument("--output", type=Path, help="Exclusive new directory under the selected project/.artifacts")
    parser.add_argument("--node", default="/opt/homebrew/bin/node")
    args = parser.parse_args()
    project = args.project.expanduser().resolve(strict=True)
    commit, before = git_commit(project), source_pins(project)
    output = create_output(project, args.output, "qualification-" + ((args.suite + "-") if args.suite else ""))
    print(json.dumps({"output": str(output), "gitCommit": commit,
                      "sourceFiles": len(before), "suite": args.suite or "all"}), flush=True)
    base = {"schemaVersion": 1, "gitCommit": commit, "sourceDirectory": str(project / "source"),
            "sourcePins": before, "command": invocation(), "startedUTC": utc()}
    error = None
    if args.suite:
        suite = Suite(args, project, output, commit, before)
        try:
            suite.run()
            require(git_commit(project) == commit, "Git commit changed during suite execution")
        except Exception as exc:
            error = str(exc)
        unchanged = source_pins(project) == before
        result = {**base, "name": args.suite, "scope": SCOPES[args.suite],
                  "rows": suite.rows, "retainedEvidence": suite.retained,
                  "fixtureDirectory": str(suite.cache), "sourceUnchanged": unchanged,
                  "passed": sum(row.get("passed", 0) for row in suite.rows),
                  "failed": sum(row.get("failed", 0) for row in suite.rows)}
        if hasattr(suite, "fixture"):
            result["fixtureAdaptation"] = suite.fixture
        if error or not unchanged or not result["passed"]:
            result["failed"] = max(result["failed"], 1)
        result.update(exitCode=1 if result["failed"] else 0, error=error, completedUTC=utc())
        path = output / "RESULT.json"
    else:
        rows = []
        for name in SUITES:
            command = [launched_interpreter(), "-B", str(SELF),
                       "--project", str(project), "--suite", name, "--output", str(output / name),
                       "--node", str(Path(args.node).resolve(strict=True))]
            log = output / (name + ".log")
            print("START " + name, flush=True)
            execution = execute(command, log, project, os.environ.copy(), timeout=1200)
            row = {"name": name, **execution, "scope": SCOPES[name], "passed": 0, "failed": 1}
            try:
                path = output / name / "RESULT.json"
                actual = json.loads(read_regular(path))
                row["result"] = ref(path)
                require(execution["exitCode"] == actual.get("exitCode") == 0
                        and actual.get("failed") == 0 and actual.get("sourceUnchanged") is True
                        and actual.get("sourceDirectory") == str(project / "source")
                        and actual.get("sourcePins") == before
                        and actual.get("gitCommit") == commit,
                        "Suite execution/provenance did not qualify: " + name)
                verify_command(actual.get("command"), command)
                require(type(actual.get("passed")) is int and actual["passed"] > 0,
                        "Positive actual suite count required")
                row.update(passed=actual["passed"], failed=0)
                require(source_pins(project) == before and git_commit(project) == commit,
                        "Source or Git commit changed during qualification")
                print("PASS " + name + ": " + str(row["passed"]), flush=True)
            except Exception as exc:
                error = str(exc)
                row["error"] = error
                print("FAIL " + name + ": " + error, flush=True)
                print(read_regular(log).decode("utf-8", errors="replace")[-8000:], flush=True)
            rows.append(row)
            if error:
                break
        unchanged = source_pins(project) == before
        result = {**base, "suites": rows, "sourceUnchanged": unchanged,
                  "passed": sum(row["passed"] for row in rows),
                  "failed": sum(row["failed"] for row in rows),
                  "requiredSuites": list(SUITES)}
        if error or not unchanged or len(rows) != len(SUITES):
            result["failed"] = max(result["failed"], 1)
        result.update(exitCode=1 if result["failed"] else 0, error=error, completedUTC=utc())
        path = output / "qualification.json"
    save_new(path, result)
    print(json.dumps({"report": str(path), "sha256": ref(path)["sha256"],
                      "exitCode": result["exitCode"], "passed": result["passed"],
                      "failed": result["failed"], "sourceUnchanged": result["sourceUnchanged"]}), flush=True)
    return result["exitCode"]

if __name__ == "__main__":
    sys.exit(main())
