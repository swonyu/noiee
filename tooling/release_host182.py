"""Noiee 182 host release adapter.

Adapted from the committed Build181 adapter (49b2232); historical guard functions are
vendored byte-for-byte with provenance. This host-specific installer is separate
from the portable, non-installing native compiler in build_native.py.

freeze only records source hashes. prepare/build/install are explicit phases.
No app, model, UI, original database, recovery, or lease operation is launched.
The original bundle path, identifier, data and authentic admission stay bound.
Old release recipes and receipts are never edited or enabled.
"""
from pathlib import Path
import argparse, ast, copy, datetime, hashlib, json, os, plistlib, re
import shutil, stat, subprocess, sys, tempfile, types, uuid
sys.dont_write_bytecode = True

ROOT = Path("/Users/saleh/Documents/Noiee")
PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "source"
RELEASE = ROOT / 'releases/build182'
APP = Path("/Users/saleh/Applications/Saleh Uncensored.app")
SUPPORT = Path("/Users/saleh/Library/Application Support")
STAGING = SUPPORT / "Saleh Uncensored Release Staging"
OLD = STAGING / 'Noiee181-4wd68a6s'
HELPERS = PROJECT / "tooling/release_helpers"
DEPENDENCIES = ROOT / "dependencies/node-26.13.0-build171"
INTENTS = SUPPORT / "Saleh Uncensored Runtime/Release Intents"
SIGNING = "01BE58A036F57AF09A20C06858B9C856115B35E8"
RELEASE_NODE = Path("/opt/homebrew/bin/node")
RELEASE_NODE_SHA = "7296c3dda88793e08d1089d839a782178c4bba6bb22f5c40ab2a75263fb071bd"
CAPTURE = PROJECT / "tooling/capture_closed_boundary182.py"
CAPTURE_SHA = '6a469464871c45e07765c382ae0bf27312572a0ed4b2cc65306c0f2bf00a35da'
R88 = HELPERS / "filesystem_identity.py"
R88_SHA = "4a113bd4073d391080ad1941c307109498e359d22072339a605adcc559454d55"
OLD_PINS = {
    "source-manifest.json": 'f8ddd0d050bc956d173f8afd862cdef36eef387c7c826c7228771a3ab70e5c49',
    "candidate-bundle-manifest.json": '51fc2931d6a65ad4d729f968effea8ef1efcf372ce022d9ca5a4428fe405eb64',
    "candidate-receipt.json": '5c6362c0bc772bb29e71f4996d15336e04d01af47515d005ea9d883de4bdc0ae',
}
HELPER_PINS = {
    "build-candidate.py": "185fd10cf66b9a87054db4d3a13b6cdfa82c22190ad219b6492bc9ee5528ae03",
    "prepare-release.py": "4b87319ee9bbfb558690d640ed96fd10d6c65bdb62e42bc75f740cc06057213c",
    "install-guarded.py": "3dca6ef18a6e2900648ddf8d62b28b6aac590fd8f67fe557894798a3991cfc9f",
}
FETCH_IMMUTABLE = {
    "fetch-plugin-runtime.py", "fetch-python-v20261024-contract.json",
    "fetch-runtime-v20261024-manifest.json", "fetch-runtime-v20261024.zip",
}
RESOURCE_SUFFIXES = {".mjs", ".js", ".json", ".html", ".css", ".exp", ".txt"}
GENERATED = {"legacy-admission.json", "legacy-boot-helper"}
ARTIFACT_ROOTS = (PROJECT / ".artifacts", ROOT / 'updates/build182', RELEASE)
SYSTEM_BUILD_ROOTS = (Path("/Applications"), Path("/Library/Developer"), Path("/usr/bin"))
REQUIRED_SUITES = {"compaction-recovery", "model-stabilization", "startup-diagnostics",
                   "presentation", "catalog", "goals", "submission-origin", "mcp-skills", "fetch", "worktrees", "account-extensions"}
NATIVE_FRAMEWORKS = ("AppKit", "WebKit", "UniformTypeIdentifiers", "ScreenCaptureKit",
                     "ApplicationServices", "Contacts", "Security", "ImageIO", "PDFKit")

SELF_CHECK_PREFIXES = (
    "PASS: proposal and element-action validation,",
    "PASS: phone URL normalization,",
    "PASS: bundled routine-read provenance,",
    "PASS: native recovery startup permits retained reads,",
    "PASS: native access mode persistence,",
)


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()


def canonical(path):
    p = Path(path)
    require(p.is_absolute() and ".." not in p.parts and p.resolve(strict=True) == p,
            "Noncanonical path: " + str(p))
    return p


def raw(path, pin=None, limit=512 * 1024 * 1024, mode=None):
    p = canonical(path)
    before = p.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and before.st_uid == os.getuid() and before.st_size <= limit,
            "Unsafe file: " + str(p))
    if mode is not None:
        require(stat.S_IMODE(before.st_mode) == mode, "File mode differs: " + str(p))
    value = p.read_bytes()
    after = p.lstat()
    keys = ("st_dev", "st_ino", "st_size", "st_mode", "st_uid",
            "st_nlink", "st_mtime_ns", "st_ctime_ns")
    require(all(getattr(before, k) == getattr(after, k) for k in keys)
            and len(value) == before.st_size, "File changed during read: " + str(p))
    require(pin is None or sha(value) == pin, "Reference changed: " + str(p))
    return value


def ref(path):
    return {"path": str(canonical(path)), "sha256": sha(raw(path))}


def read_ref(value):
    require(type(value) is dict and set(value) == {"path", "sha256"}
            and type(value["sha256"]) is str
            and re.fullmatch("[0-9a-f]{64}", value["sha256"]),
            "Exact artifact reference required")
    return raw(value["path"], value["sha256"])


def document(value):
    return json.loads(read_ref(value))


def private(path, create=False):
    p = Path(path)
    if create:
        p.mkdir(mode=0o700, exist_ok=False)
    canonical(p)
    s = p.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid()
            and not stat.S_IMODE(s.st_mode) & 0o077, "Directory is not private: " + str(p))
    return p


def module(path, pin, name):
    value = types.ModuleType(name)
    value.__file__ = str(path)
    exec(compile(raw(path, pin), str(path), "exec"), value.__dict__)
    return value


def load_helpers(stage):
    h = module(HELPERS / "build-candidate.py",
               HELPER_PINS["build-candidate.py"], "noiee_core_guards").__dict__
    h.update(BASE=stage, SOURCE=stage / "source")
    for filename, names in (
        ("prepare-release.py", {"copy_exact"}),
        ("install-guarded.py", {"replace_bundle", "observe_model_listener"}),
    ):
        tree = ast.parse(raw(HELPERS / filename, HELPER_PINS[filename]))
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        require({n.name for n in nodes} == names, "Pinned helper API missing")
        if filename == "install-guarded.py":
            changes = {
                "verified-build40-installed": 'verified-noiee182-installed',
                "Build40-postcheck-failed.app": 'Noiee182-postcheck-failed.app',
            }
            labels = [n for f in nodes for n in ast.walk(f)
                      if isinstance(n, ast.Constant) and type(n.value) is str
                      and n.value in changes]
            require(len(labels) == 2, "Pinned transaction labels changed")
            for n in labels:
                n.value = changes[n.value]
        exec(compile(ast.Module(body=nodes, type_ignores=[]),
                     str(HELPERS / filename), "exec"), h)
    return h


def write(h, path, value):
    h["write_new"](Path(path), json.dumps(value, indent=2).encode() + b"\n", 0o600)


def git_state():
    result = subprocess.run(
        ["/usr/bin/git", "-C", str(PROJECT), "status", "--porcelain=v1", "--untracked-files=all"],
        capture_output=True, text=True, timeout=20, check=True,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    top = subprocess.check_output(["/usr/bin/git", "-C", str(PROJECT),
                                   "rev-parse", "--show-toplevel"], text=True, timeout=20).strip()
    commit = subprocess.check_output(["/usr/bin/git", "-C", str(PROJECT),
                                      "rev-parse", "HEAD"], text=True, timeout=20).strip()
    require(Path(top) == PROJECT and re.fullmatch("[0-9a-f]{40}", commit),
            "Expected the integrated Git checkout")
    require(not result.stdout.strip(), "Commit the exact source and tooling before freezing")
    return commit


def source_snapshot():
    canonical(PROJECT)
    canonical(SOURCE)
    commit = git_state()
    tracked = subprocess.check_output(
        ["/usr/bin/git", "-C", str(PROJECT), "ls-files", "-z"], timeout=20).decode().split("\0")
    project_files = {}
    for name in filter(None, tracked):
        require(not Path(name).is_absolute() and ".." not in Path(name).parts,
                "Unexpected tracked path")
        data = raw(PROJECT / name)
        project_files[name] = {"sha256": sha(data), "bytes": len(data),
                              "mode": stat.S_IMODE((PROJECT / name).lstat().st_mode)}
    files = {}
    # The current product resource namespace is flat. A new directory needs an
    # explicit packaging change; it cannot silently disappear from a release.
    for path in sorted(SOURCE.iterdir()):
        if path.name == "node_modules":
            continue
        data = raw(path)
        files[path.name] = {"sha256": sha(data), "bytes": len(data),
                            "mode": stat.S_IMODE(path.lstat().st_mode)}
    require(files and any(n.endswith(".swift") for n in files)
            and {"source/" + n: row for n, row in files.items()} ==
                {n: row for n, row in project_files.items() if n.startswith("source/")},
            "Source files must exactly match the tracked source namespace")
    link = SOURCE / "node_modules"
    require(link.is_symlink() and os.readlink(link) == str(DEPENDENCIES)
            and link.resolve(strict=True) == DEPENDENCIES,
            "Source must use the owned stable dependency snapshot")
    require(git_state() == commit, "Git commit changed during freeze")
    return {"version": 2, "sourceDirectory": str(SOURCE), "gitCommit": commit,
            "regularFiles": len(files), "files": files, "projectFiles": project_files,
            "dependencyLink": {"target": str(DEPENDENCIES),
                               "mode": stat.S_IMODE(link.lstat().st_mode)}}


def pin_sources(pins, files, project_files, complete=False):
    require(type(pins) is dict and pins, "Test source pins are missing")
    expected = {name: row["sha256"] for name, row in files.items()}
    if complete:
        require(pins == expected, "Qualification must bind every final source file exactly")
        return
    for name, pin in pins.items():
        require(type(name) is str and type(pin) is str and re.fullmatch("[0-9a-f]{64}", pin),
                "Source pin must be a relative name and SHA256")
        row = files.get(name) if "/" not in name else project_files.get(name)
        require(row is not None and row["sha256"] == pin,
                "Tested source or fixture differs from the committed freeze: " + name)


def artifact_reference(value, roots=(), owners=None, limit=512 * 1024 * 1024):
    require(type(value) is dict and {"path", "sha256"} <= set(value) <= {"path", "sha256", "bytes"}
            and type(value["path"]) is str and type(value["sha256"]) is str
            and re.fullmatch("[0-9a-f]{64}", value["sha256"]), "Exact artifact reference required")
    path = canonical(value["path"])
    if roots:
        require(any(path.is_relative_to(root) and path != root for root in roots),
                "Artifact is outside the current build's allowed roots: " + str(path))
    before = path.lstat()
    permitted = (os.getuid(),) if owners is None else owners
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and before.st_uid in permitted and before.st_size <= limit, "Unsafe artifact")
    data = path.read_bytes()
    after = path.lstat()
    keys = ("st_dev", "st_ino", "st_uid", "st_size", "st_mode", "st_nlink", "st_mtime_ns", "st_ctime_ns")
    require(all(getattr(before, k) == getattr(after, k) for k in keys)
            and len(data) == before.st_size and sha(data) == value["sha256"],
            "Artifact changed: " + str(path))
    require("bytes" not in value or type(value["bytes"]) is int
            and value["bytes"] == len(data), "Artifact byte count differs")
    return data


def valid_command(value):
    return (type(value) is list and bool(value)
            and all(type(item) is str and item and "\0" not in item
                    and len(item) <= 16384 for item in value))


def report_counts(report):
    require(type(report) is dict, "Executed result must be an object")
    result = report if type(report.get("passed")) is int else report.get("result")
    require(type(result) is dict and type(result.get("passed")) is int and result["passed"] > 0
            and type(result.get("failed")) is int and result["failed"] == 0,
            "Executed result needs positive actual pass and zero failure counts")
    return result["passed"]


def node_runtime():
    contract = json.loads(raw(SOURCE / "runtime-contract.json"))
    require(contract == {
        "schemaVersion": 1,
        "node": {"version": "v26.13.0", "executableSHA256": RELEASE_NODE_SHA,
                 "candidates": ["/opt/homebrew/bin/node", "/usr/local/bin/node"]},
        "backend": {"host": "127.0.0.1", "port": 8787}},
        "Runtime contract differs from the explicitly supported host release runtime")
    executable = ref(RELEASE_NODE.resolve(strict=True))
    require(executable["sha256"] == RELEASE_NODE_SHA,
            "Supported Node executable changed; qualify the new runtime before releasing")
    version = subprocess.check_output([executable["path"], "--version"], text=True,
                                      timeout=15).strip()
    require(version == "v26.13.0", "Supported release Node runtime is unavailable")
    return {"command": str(RELEASE_NODE), "executable": executable, "version": version}






def verify_account_suite(actual, frozen):
    path = PROJECT / "tooling/qualify182.py"
    pin = frozen["projectFiles"].get("tooling/qualify182.py", {}).get("sha256")
    require(type(pin) is str and re.fullmatch("[0-9a-f]{64}", pin),
            "Frozen account qualification validator missing")
    validator = module(path, pin, "noiee_182_qualification")
    rows = actual.get("rows")
    require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict,
            "Account suite requires one complete strict gate")
    row = rows[0]
    require(row.get("name") == "account-extensions"
            and type(row.get("passed")) is int and row["passed"] == 1
            and type(row.get("failed")) is int and row["failed"] == 0
            and type(row.get("exitCode")) is int and row["exitCode"] == 0
            and row.get("sourceUnchanged") is True
            and row.get("countUnit") == validator.ACCOUNT_GATE_UNIT,
            "Account suite completion/count units differ")
    command = row.get("command")
    require(valid_command(command) and len(command) == 4
            and command[1:] == ["-B", str(PROJECT / validator.ACCOUNT_RUNNER), "run"],
            "Account suite runner invocation differs")
    receipt = row.get("accountReceipt")
    value = validator.verify_account_extensions(PROJECT, receipt, frozen["gitCommit"], frozen["projectFiles"])
    require(json.dumps(row.get("constituentTotals"), sort_keys=True) == json.dumps(value["totals"], sort_keys=True), "Account constituent totals differ")
    inputs = json.loads(artifact_reference(value["inputsBefore"], ARTIFACT_ROOTS))
    require(command[0] == inputs["tools"]["python"]["path"], "Account runner interpreter differs")
    log = artifact_reference(row["log"], ARTIFACT_ROOTS).decode("utf-8", errors="strict")
    results = [item for item in validator.parse_json_lines(log) if "receipt" in item]
    require(len(results) == 1 and results[0].get("passed") is True
            and results[0].get("receipt") == {**receipt, "bytes": len(artifact_reference(receipt, ARTIFACT_ROOTS))}
            and json.dumps(results[0].get("totals"), sort_keys=True) == json.dumps(value["totals"], sort_keys=True) and results[0].get("error") is None,
            "Account wrapper output does not bind the verified receipt")


def verify_reports(cfg, frozen):
    files, project_files = frozen["files"], frozen["projectFiles"]
    artifacts, totals, executions = {}, {}, {}
    def remember(value):
        data = artifact_reference(value, ARTIFACT_ROOTS, limit=32 * 1024 * 1024)
        old = artifacts.setdefault(value["path"], value["sha256"])
        require(old == value["sha256"], "Conflicting artifact references")
        return data
    report = json.loads(remember(cfg["qualification"]))
    require(type(report) is dict and type(report.get("schemaVersion")) is int
            and report["schemaVersion"] == 1
            and report.get("gitCommit") == frozen["gitCommit"]
            and report.get("sourceUnchanged") is True,
            "Qualification commit or source stability differs")
    pin_sources(report.get("sourcePins"), files, project_files, complete=True)
    suites = report.get("suites")
    require(type(suites) is list and suites, "Executed qualification suite rows required")
    names = [r.get("name") if type(r) is dict else None for r in suites]
    require(all(type(n) is str and re.fullmatch("[a-z][a-z0-9-]*", n) for n in names)
            and len(names) == len(set(names)) and REQUIRED_SUITES <= set(names),
            "Missing, duplicate, or invalid required qualification suite names")
    used_paths = set()

    def nested(value):
        if type(value) is dict:
            if {"path", "sha256"} <= set(value) <= {"path", "sha256", "bytes"}:
                remember(value)
                return
            for key, child in value.items():
                if key in {"sourcePins", "sourceHashes"}:
                    pin_sources(child, files, project_files)
                else:
                    nested(child)
        elif type(value) is list:
            for child in value:
                nested(child)

    for row in suites:
        name = row["name"]
        require(type(row.get("exitCode")) is int and row["exitCode"] == 0
                and type(row.get("failed")) is int and row["failed"] == 0
                and type(row.get("passed")) is int and row["passed"] > 0
                and valid_command(row.get("command"))
                and type(row.get("scope")) is str and row["scope"].strip(),
                "Failed, empty, or unexecuted suite: " + name)
        require(type(row.get("log")) is dict and type(row.get("result")) is dict,
                "Suite needs both its real output log and execution result")
        for field in ("log", "result"):
            value = row[field]
            require(value.get("path") not in used_paths, "Suite artifacts must be distinct")
            remember(value)
            used_paths.add(value["path"])
        actual = json.loads(remember(row["result"]))
        require(type(actual) is dict, "Executed suite result must be an object")
        require(type(actual.get("exitCode")) is int and actual["exitCode"] == 0
                and actual.get("sourceUnchanged") is True
                and actual.get("sourceDirectory") == str(SOURCE)
                and report_counts(actual) == row["passed"],
                "Normalized counts/source differ from the executed result: " + name)
        pin_sources(actual.get("sourcePins"), files, project_files)
        if "gitCommit" in actual:
            require(actual["gitCommit"] == frozen["gitCommit"], "Suite commit differs")
        if "name" in actual:
            require(actual["name"] == name, "Executed suite name differs")
        if "command" in actual:
            require(actual["command"] == row["command"], "Executed command differs")
        if "log" in actual:
            require(actual["log"] == row["log"], "Executed log binding differs")
        # Aggregates retain each actual constituent execution. Their wrapper
        # command/output are bound by the normalized row; constituent failures
        # or a different count cannot be hidden by the wrapper total.
        children = actual.get("rows", actual.get("suites"))
        if children is not None:
            require(type(children) is list and children, "Empty execution aggregate")
            child_count = 0
            for child in children:
                require(type(child) is dict and type(child.get("exitCode")) is int
                        and child["exitCode"] == 0 and valid_command(child.get("command")),
                        "A constituent execution failed or lacks its command")
                if "passed" in child or "result" in child:
                    child_count += report_counts(child)
            if child_count:
                require(child_count == row["passed"], "Constituent execution counts differ")
        if name == "account-extensions":
            verify_account_suite(actual, frozen)
        nested(actual)
        totals[name] = row["passed"]
        executions[name] = {k: row[k] for k in ("command", "exitCode", "passed", "failed",
                                                "log", "result", "scope")}
    return {"artifacts": artifacts, "passedBySuite": totals, "executions": executions}


def verify_native(value, frozen):
    data = artifact_reference(value, ARTIFACT_ROOTS, limit=8 * 1024 * 1024)
    native = json.loads(data)
    files = frozen["files"]
    swift = {name: row["sha256"] for name, row in files.items() if name.endswith(".swift")}
    require(type(native) is dict and native.get("schemaVersion") == 2
            and native.get("build") == 182 and native.get("sourceDirectory") == str(SOURCE)
            and native.get("sourceCommit") == frozen["gitCommit"]
            and native.get("sourceManifest") == files and native.get("nativeFiles") == swift
            and native.get("gitStatus") == "" and native.get("sourceStableDuringBuild") is True
            and native.get("releaseEligible") is True and native.get("development") is False
            and all(native.get(k) is False for k in ("signed", "installed", "appLaunched", "modelInvoked"))
            and all(type(native.get(k)) is int and native[k] == 0
                    for k in ("compilerExit", "selfCheckExit", "exitCode")),
            "Release-eligible native compilation from the exact final commit is required")
    builder = native.get("builder")
    require(type(builder) is dict and builder.get("path") == str(PROJECT / "tooling/build_native.py")
            and builder.get("sha256") == frozen["projectFiles"]["tooling/build_native.py"]["sha256"],
            "Native builder differs from the frozen tracked tooling")
    artifact_reference(builder, (PROJECT,))
    refs = {value["path"]: value["sha256"]}
    for key in ("binary", "compilerLog", "selfCheckLog"):
        item = native[key]
        artifact_reference(item, ARTIFACT_ROOTS,
                           limit=512 * 1024 * 1024 if key == "binary" else 8 * 1024 * 1024)
        refs[item["path"]] = item["sha256"]
    binary = Path(native["binary"]["path"])
    artifact = binary.parent
    require(binary.name == "QwenLocal" and Path(value["path"]) == artifact / "native-build.json"
            and Path(native["compilerLog"]["path"]) == artifact / "compiler.log"
            and Path(native["selfCheckLog"]["path"]) == artifact / "self-check.log",
            "Native artifact layout differs")
    toolchain = native["toolchain"]
    require(toolchain.get("target") == "arm64-apple-macos15.2"
            and all(type(toolchain.get(k)) is str and toolchain[k].strip() for k in (
                "compilerInvocation", "compilerVersion", "sdkPath", "sdkVersion",
                "xcodeVersion", "developerDirectory", "hostVersion")),
            "Native compiler/SDK provenance is incomplete")
    invocation = Path(toolchain["compilerInvocation"])
    require(invocation.is_absolute() and invocation.name == "swiftc"
            and str(invocation.resolve(strict=True)) == toolchain["compiler"]["path"],
            "Native compiler driver binding differs")
    sdk = canonical(toolchain["sdkPath"])
    require(sdk.is_dir() and Path(toolchain["sdkSettings"]["path"]) in {
                sdk / "SDKSettings.json", sdk / "SDKSettings.plist"},
            "Native SDK settings binding differs")
    for key in ("compiler", "sdkSettings"):
        artifact_reference(toolchain[key], SYSTEM_BUILD_ROOTS, owners=(0, os.getuid()))
    expected = [str(invocation), "-O", "-sdk", str(sdk), "-target",
                "arm64-apple-macos15.2", "-parse-as-library",
                "-module-cache-path", str(artifact / "module-cache")]
    for framework in NATIVE_FRAMEWORKS:
        expected.extend(["-framework", framework])
    expected.extend([str(SOURCE / name) for name in sorted(swift)] + ["-o", str(binary)])
    require(native.get("command") == expected
            and native.get("selfCheckCommand") == [str(binary), "--check-computer"],
            "Native compiler/self-check command differs")
    output = artifact_reference(native["selfCheckLog"], ARTIFACT_ROOTS).decode()
    lines = output.splitlines()
    require(output == native.get("selfCheckOutput") and len(lines) == len(SELF_CHECK_PREFIXES)
            and all(line.startswith(prefix) for line, prefix in zip(lines, SELF_CHECK_PREFIXES)),
            "Actual native self-check output differs")
    return native, refs


def verify_immutable_payloads(files, old_files):
    for name in sorted(FETCH_IMMUTABLE):
        require(name in files and name in old_files
                and files[name]["sha256"] == old_files[name]["sha256"],
                "Signed Build171 Fetch payload/contract changed: " + name)


def context(input_ref, stage):
    require(PROJECT == ROOT / "project", "Run the integrated project checkout, not a development worktree")
    artifact_reference(input_ref, (RELEASE,), limit=1024 * 1024)
    cfg = document(input_ref)
    required = {"version", "build", "sourceDirectory", "sourceManifest", "closedBoundary",
                "nativeBuild", "qualification"}
    require(type(cfg) is dict and set(cfg) == required
            and cfg["version"] == 1 and cfg["build"] == 182
            and cfg["sourceDirectory"] == str(SOURCE), "Release input schema/scope differs")
    artifact_reference(cfg["sourceManifest"], (RELEASE,), limit=16 * 1024 * 1024)
    frozen = document(cfg["sourceManifest"])
    require(frozen == source_snapshot(), "Source or tracked tooling changed since freeze")
    h = load_helpers(stage)
    old = {n: document({"path": str(OLD / n), "sha256": pin}) for n, pin in OLD_PINS.items()}
    previous, before, package = (old[n] for n in (
        "source-manifest.json", "candidate-bundle-manifest.json", "candidate-receipt.json"))
    old_files = {n: r for n, r in previous["sourceManifest"].items() if r["type"] == "file"}
    files = frozen["files"]
    require(set(old_files) <= set(files) and not set(files) & (GENERATED | {"owned-runtime.json"}),
            "Removal or generated/runtime source collision requires separate packaging review")
    require(h["manifest"](DEPENDENCIES, True) == previous["dependencyManifest"],
            "Owned stable dependency snapshot differs from its trusted contents")
    verify_immutable_payloads(files, old_files)
    require(files["filesystem-identity.mjs"]["sha256"] ==
            old_files["filesystem-identity.mjs"]["sha256"], "Filesystem verifier changed")
    artifact_reference(cfg["closedBoundary"], (RELEASE,), limit=128 * 1024 * 1024)
    boundary = document(cfg["closedBoundary"])
    require(boundary["version"] == 1
            and boundary["phase"] == "observed-current-stopped-preservation-baseline"
            and boundary["captureSource"] == {"path": str(CAPTURE), "sha256": CAPTURE_SHA}
            and boundary["pinnedGuards"] == {
                "path": str(HELPERS / "build-candidate.py"),
                "sha256": HELPER_PINS["build-candidate.py"]}
            and boundary["predecessorPackage"] == {
                "path": str(OLD / "candidate-receipt.json"),
                "sha256": OLD_PINS["candidate-receipt.json"]}
            and boundary["twoCompleteObservationsEqual"] is True
            and boundary["processAndPortChecksPassed"] is True
            and boundary["installedBuild"] == '181' and boundary["bundlePath"] == str(APP)
            and boundary["bundleIdentifier"] == "com.saleh.qwenlocal.chat"
            and boundary["bundleManifest"] == before
            and all(boundary[k] is False for k in (
                "sourceStoresOpenedBySQLite", "appOrModelInvoked", "originalDataWritten",
                "backupCreated", "historicalNormalQuitClaimed", "ownerRecoveryClaimed",
                "releaseAdmissionClaimed", "nativeAcceptancePassed")),
            "Fresh preservation boundary schema differs")
    require(package["version"] == 1 and package["build"] == 181 and package["baselineBuild"] == 180
            and package["candidateBundleManifest"] == {
                "path": str(OLD / "candidate-bundle-manifest.json"),
                "sha256": OLD_PINS["candidate-bundle-manifest.json"]}
            and package["sourceManifest"] == {
                "path": str(OLD / "source-manifest.json"),
                "sha256": OLD_PINS["source-manifest.json"]}
            and package["binarySHA256"] == before["Contents/MacOS/QwenLocal"]["sha256"]
            and all(package[k] is True for k in (
                "signatureVerified", "sameDesignatedRequirement", "archiveRoundtripVerified")),
            'Authentic signed Build181 predecessor differs')
    native, native_refs = verify_native(cfg["nativeBuild"], frozen)
    evidence = verify_reports(cfg, frozen)
    capture = module(CAPTURE, CAPTURE_SHA, 'noiee_182_boundary_support')
    r88 = module(R88, R88_SHA, "noiee_vendored_filesystem_identity")
    runtime = node_runtime()
    r88.NODE, r88.require = runtime["executable"]["path"], require
    c = dict(cfg=cfg, input=input_ref, frozen=frozen, files=files, h=h,
             old=previous, before=before, boundary=boundary, native=native,
             nativeRefs=native_refs, evidence=evidence, capture=capture, r88=r88,
             releaseRuntime=runtime)
    guard(c)
    catalog = json.loads(raw(h["CODING"] / "coding-owners.json",
                            boundary["ownership"]["sha256"], limit=4 * 1024 * 1024))
    saved = catalog["legacy"]["admission"]
    intent, envelope = previous["proof"]["intent"], previous["proof"]["envelope"]
    require(document(envelope["intent"]) == intent
            and json.loads(raw(APP / "Contents/Resources/legacy-admission.json")) == envelope,
            "Installed authentic admission differs")
    document(intent["admissionIntent"])
    require(saved["intentSha256"] in {
                envelope["intent"]["sha256"], intent["predecessorIntentSha256"]}
            and saved["dataDirectory"] == intent["dataDirectory"]
            and saved["previousBootSession"] == intent["bootSession"]
            and saved["admissionIntentSha256"] == intent["admissionIntent"]["sha256"],
            "Actual saved admission is outside the signed predecessor lineage")
    c["savedAdmission"] = saved
    return c


def stopped(c):
    h, cap, b = c["h"], c["capture"], c["boundary"]
    cap.require_stopped(h)
    require(h["boot_session"]() == b["bootSession"], "Kernel boot changed")
    require(cap.catalog_state(h) == b["ownership"], "Closed owner boundary changed")


def guard(c, installed_predecessor=True):
    require(str(RELEASE_NODE.resolve(strict=True)) == c["releaseRuntime"]["executable"]["path"],
            "Release Node selection changed")
    read_ref(c["releaseRuntime"]["executable"])
    require(source_snapshot() == c["frozen"], "Source or tracked tooling changed after freeze")
    require(c["h"]["manifest"](DEPENDENCIES, True) == c["old"]["dependencyManifest"],
            "Stable dependency contents changed")
    for path, pin in {**c["evidence"]["artifacts"], **c["nativeRefs"]}.items():
        artifact_reference({"path": path, "sha256": pin}, ARTIFACT_ROOTS)
    for key in ("compiler", "sdkSettings"):
        artifact_reference(c["native"]["toolchain"][key], SYSTEM_BUILD_ROOTS, owners=(0, os.getuid()))
    stopped(c)
    c["h"]["verify_data"](c["boundary"])
    if installed_predecessor:
        require(c["h"]["manifest"](APP) == c["before"]
                and c["h"]["requirement"](APP) == c["boundary"]["designatedRequirement"],
                "Installed predecessor changed")


def run(c, stage, label, argv, timeout=120):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    write(c["h"], stage / "logs" / (label + ".json"),
          {"command": argv, "exitCode": result.returncode,
           "stdout": result.stdout, "stderr": result.stderr})
    require(result.returncode == 0, label + " failed; stage retained")
    return result


def prepared(stage, pin):
    stage = private(stage)
    require(stage.parent == STAGING and stage.name.startswith('Noiee182-'),
            "Foreign release stage")
    p = document({"path": str(stage / "prepared.json"), "sha256": pin})
    require(p["adapter"] == ref(__file__), "Release adapter changed after preparation")
    c = context(p["input"], stage)
    h = c["h"]
    require(p["sourceManifest"] == c["cfg"]["sourceManifest"]
            and p["evidence"] == c["evidence"]
            and p["releaseRuntime"] == c["releaseRuntime"]
            and h["manifest"](stage / "source", True) == p["stagedSource"]
            and h["manifest"](stage / "dependencies", True) == c["old"]["dependencyManifest"]
            and h["manifest"](stage / "resources") == p["resourceManifest"]
            and ref(stage / "approved-Info.plist") == p["plist"],
            "Prepared source/resources/evidence changed")
    return c, p


def prepare(input_ref):
    private(RELEASE)
    require(STAGING.is_dir(), "Existing private staging root missing")
    private(STAGING)
    # Qualification happens before a new staging directory is created.
    c = context(input_ref, RELEASE)
    require(SIGNING in subprocess.check_output(
        ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"], text=True),
        "Existing signing identity unavailable")
    stage = Path(tempfile.mkdtemp(prefix='Noiee182-', dir=STAGING))
    stage.chmod(0o700)
    c = context(input_ref, stage)
    h = c["h"]
    h["begin_attempt"](stage / "prepare-attempt.json",
                       {"input": input_ref, "installed": False, "launched": False})
    for name in ("source", "logs", "candidate", "outputs"):
        private(stage / name, create=True)
    for name, row in c["files"].items():
        h["write_new"](stage / "source" / name, raw(SOURCE / name, row["sha256"]), row["mode"])
    h["copy_exact"](DEPENDENCIES, stage / "dependencies", c["old"]["dependencyManifest"])
    (stage / "source/node_modules").symlink_to("../dependencies")
    os.chmod(stage / "source/node_modules", 0o700, follow_symlinks=False)
    old_resources = h["manifest"](OLD / "resources", True)
    require({n: r for n, r in old_resources.items() if n != "."} ==
            c["old"]["resourceManifest"], "Predecessor resources changed")
    h["copy_exact"](OLD / "resources", stage / "resources", old_resources)
    expected = copy.deepcopy(c["old"]["resourceManifest"])
    changed = []
    for name, row in c["files"].items():
        if Path(name).suffix not in RESOURCE_SUFFIXES and name not in FETCH_IMMUTABLE:
            continue
        require(name not in GENERATED, "Generated admission collision")
        old_row = expected.get(name)
        if old_row and old_row.get("sha256") == row["sha256"]:
            continue
        require(name != "owned-runtime.json", "Existing runtime configuration must remain exact")
        target = stage / "resources" / name
        mode = old_row["mode"] if old_row else (0o400 if name in FETCH_IMMUTABLE else 0o600)
        if old_row:
            require(old_row["type"] == "file", "Unexpected resource type")
            raw(target, old_row["sha256"])
            target.unlink()
        else:
            require(not os.path.lexists(target), "Added resource already exists")
        h["write_new"](target, raw(stage / "source" / name, row["sha256"]), mode)
        expected[name] = {"type": "file", "mode": mode, "sha256": row["sha256"],
                          "size": row["bytes"]}
        changed.append(name)
    require(h["manifest"](stage / "resources") == expected, "Unexpected resource delta")
    info = plistlib.loads(raw(APP / "Contents/Info.plist"))
    require(info["CFBundleVersion"] == '181', "Unexpected installed build")
    info.update(CFBundleVersion='182', CFBundleName="Noiee", CFBundleDisplayName="Noiee")
    require(info["CFBundleIdentifier"] == "com.saleh.qwenlocal.chat"
            and info["CFBundleExecutable"] == "QwenLocal", "App identity changed")
    h["write_new"](stage / "approved-Info.plist", plistlib.dumps(info), 0o600)
    guard(c)
    value = {
        "version": 1, "build": 182, "adapter": ref(__file__), "input": input_ref,
        "sourceManifest": c["cfg"]["sourceManifest"], "gitCommit": c["frozen"]["gitCommit"],
        "releaseRuntime": c["releaseRuntime"],
        "stagedSource": h["manifest"](stage / "source", True),
        "resourceManifest": expected, "resourceChanged": sorted(changed),
        "plist": ref(stage / "approved-Info.plist"), "evidence": c["evidence"],
    }
    write(h, stage / "prepared.json", value)
    print(json.dumps({"stage": str(stage), "prepared": ref(stage / "prepared.json"),
                      "installed": False}))


def successor_intent(c, successor):
    original = c["old"]["proof"]["intent"]
    return {
        "version": 3, "kind": "legacy-history-successor-update",
        "dataDirectory": original["dataDirectory"], "bootSession": original["bootSession"],
        "oldApplication": {"path": str(APP),
                           "payloadSha256": c["before"]["Contents/MacOS/QwenLocal"]["sha256"]},
        "successorSha256": sha(compact(successor)),
        "admissionIntent": original["admissionIntent"],
        "predecessorIntentSha256": c["savedAdmission"]["intentSha256"],
    }


def proof(c, stage, app, source):
    h = c["h"]
    envelope = source["proof"]["envelope"]
    resources = app / "Contents/Resources"
    intent = document(envelope["intent"])
    require(intent == source["proof"]["intent"] ==
            successor_intent(c, envelope["successor"]), "Successor admission differs")
    require(raw(envelope["intent"]["path"], envelope["intent"]["sha256"], mode=0o400)
            == compact(intent) + b"\n"
            and raw(resources / "legacy-admission.json", mode=0o444)
            == compact(envelope) + b"\n", "Immutable admission bytes differ")
    helper_pin = c["old"]["proof"]["envelope"]["successor"]["nativeHelper"]["sha256"]
    expected_successor = {
        "files": [{"path": n, "sha256": r["sha256"]}
                  for n, r in sorted(source["resourceManifest"].items())
                  if r["type"] == "file" and "/" not in n],
        "nativeHelper": {"path": str(APP / "Contents/Resources/legacy-boot-helper"),
                         "sha256": helper_pin},
    }
    require(envelope["successor"] == expected_successor, "Successor coverage differs")
    for row in expected_successor["files"]:
        raw(resources / row["path"], row["sha256"], limit=64 * 1024 * 1024)
    helper = resources / "legacy-boot-helper"
    raw(helper, helper_pin, mode=0o555)
    require(h["requirement"](helper, False) == c["old"]["proof"]["helperRequirement"],
            "Signed native helper identity differs")
    c["r88"].filesystem_identity(h, stage, helper, intent["dataDirectory"])


def build(stage, pin):
    c, p = prepared(stage, pin)
    h = c["h"]
    h["begin_attempt"](stage / "build-attempt.json",
                       {"preparedSHA256": pin, "installed": False, "launched": False})
    app = stage / "candidate" / APP.name
    run(c, stage, "copy-app", ["/usr/bin/ditto", str(APP), str(app)])
    require(h["manifest"](app) == c["before"], "Copied predecessor bundle differs")
    shutil.rmtree(app / "Contents/Resources")
    shutil.copytree(stage / "resources", app / "Contents/Resources", symlinks=True)
    (app / "Contents/Resources").chmod(c["before"]["Contents/Resources"]["mode"])
    shutil.copyfile(stage / "approved-Info.plist", app / "Contents/Info.plist")
    (app / "Contents/Info.plist").chmod(c["before"]["Contents/Info.plist"]["mode"])
    binary = app / "Contents/MacOS/QwenLocal"
    binary.write_bytes(artifact_reference(c["native"]["binary"], ARTIFACT_ROOTS))
    binary.chmod(0o700)
    source = {
        "candidateBuild": '182', "input": p["input"], "prepared": ref(stage / "prepared.json"),
        "sourceManifest": p["stagedSource"], "dependencyManifest": c["old"]["dependencyManifest"],
        "resourceManifest": p["resourceManifest"],
        "plistEntry": h["manifest"](app / "Contents/Info.plist", True)["."],
        "runtime": c["old"]["runtime"], "nativeBuild": c["cfg"]["nativeBuild"],
        "preSignBinarySHA256": c["native"]["binary"]["sha256"],
        "gitCommit": c["frozen"]["gitCommit"],
        "nativeCompilationPreviouslyVerified": True,
        "nativeCompilationPerformedThisPhase": False,
        "nativeSourceFiles": sorted(c["native"]["nativeFiles"]),
    }
    helper_pin = c["old"]["proof"]["envelope"]["successor"]["nativeHelper"]["sha256"]
    helper = app / "Contents/Resources/legacy-boot-helper"
    h["write_new"](helper, raw(APP / "Contents/Resources/legacy-boot-helper",
                              helper_pin, mode=0o555), 0o555)
    successor = {
        "files": [{"path": n, "sha256": r["sha256"]}
                  for n, r in sorted(p["resourceManifest"].items())
                  if r["type"] == "file" and "/" not in n],
        "nativeHelper": {"path": str(APP / "Contents/Resources/legacy-boot-helper"),
                         "sha256": helper_pin},
    }
    serialized = compact(successor)
    canonical_json = subprocess.check_output(
        [c["r88"].NODE, "-e",
         'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s))))'],
        input=serialized, timeout=15)
    require(canonical_json == serialized, "Successor canonicalization differs")
    guard(c)
    private(INTENTS)
    intent = successor_intent(c, successor)
    intent_path = INTENTS / ('Build182-' + str(uuid.uuid4()) + ".json")
    h["write_new"](intent_path, compact(intent) + b"\n", 0o400)
    envelope = {"version": 1, "intent": ref(intent_path), "successor": successor}
    h["write_new"](app / "Contents/Resources/legacy-admission.json",
                   compact(envelope) + b"\n", 0o444)
    source["proof"] = {"intent": intent, "envelope": envelope,
                       "helperRequirement": c["old"]["proof"]["helperRequirement"]}
    generated = {"Contents/Resources/" + n:
                 h["manifest"](app / "Contents/Resources" / n, True)["."]
                 for n in GENERATED}
    source["generatedEntries"] = generated
    h["verify_candidate"](app, source, c["boundary"], generated)
    proof(c, stage, app, source)
    run(c, stage, "sign-app",
        ["/usr/bin/codesign", "--force", "--sign", SIGNING, "--timestamp=none", str(app)])
    require(h["requirement"](app) == c["boundary"]["designatedRequirement"],
            "Candidate designated requirement changed")
    expected = h["verify_candidate"](app, source, c["boundary"], generated)
    proof(c, stage, app, source)
    delta = h["delta"](c["before"], expected)
    changed_resources = {"Contents/Resources/" + n for n in p["resourceChanged"]}
    allowed = changed_resources | {
        "Contents/Info.plist", "Contents/MacOS/QwenLocal",
        "Contents/Resources/legacy-admission.json", "Contents/_CodeSignature/CodeResources",
    }
    require(not delta["removed"] and set(delta["changed"]) <= allowed
            and set(delta["added"]) <= changed_resources,
            "Signed bundle delta exceeds reviewed changes")
    archive = stage / 'outputs/Noiee-Build182.zip'
    run(c, stage, "archive",
        ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive)])
    extracted = private(stage / "archive-review", create=True)
    run(c, stage, "archive-review", ["/usr/bin/ditto", "-x", "-k", str(archive), str(extracted)])
    require(sorted(x.name for x in extracted.iterdir()) == [APP.name]
            and h["manifest"](extracted / APP.name) == expected
            and h["requirement"](extracted / APP.name) == c["boundary"]["designatedRequirement"],
            "Archive roundtrip differs")
    proof(c, stage, extracted / APP.name, source)
    prepared(stage, pin)
    guard(c)
    write(h, stage / "source-manifest.json", source)
    write(h, stage / "candidate-bundle-manifest.json", expected)
    receipt = {
        "version": 1, "build": 182, "baselineBuild": 181,
        "adapter": ref(__file__), "prepared": ref(stage / "prepared.json"),
        "sourceManifest": ref(stage / "source-manifest.json"),
        "candidateBundleManifest": ref(stage / "candidate-bundle-manifest.json"),
        "archive": ref(archive), "binarySHA256": expected["Contents/MacOS/QwenLocal"]["sha256"],
        "bundleDelta": delta, "sameDesignatedRequirement": True,
        "signatureVerified": True, "archiveRoundtripVerified": True,
        "installed": False, "launched": False, "nativeAcceptancePassed": False,
    }
    write(h, stage / "candidate-receipt.json", receipt)
    print(json.dumps({"stage": str(stage), "package": ref(stage / "candidate-receipt.json"),
                      "installed": False}))


def install(stage, pin):
    stage = private(stage)
    require(stage.parent == STAGING and stage.name.startswith('Noiee182-'),
            "Foreign install stage")
    package = document({"path": str(stage / "candidate-receipt.json"), "sha256": pin})
    require(package["adapter"] == ref(__file__)
            and package["prepared"]["path"] == str(stage / "prepared.json")
            and package["build"] == 182 and package["baselineBuild"] == 181
            and all(package[k] is True for k in (
                "sameDesignatedRequirement", "signatureVerified", "archiveRoundtripVerified"))
            and package["installed"] is False and package["launched"] is False,
            "Prepared signed package required")
    c, p = prepared(stage, package["prepared"]["sha256"])
    h = c["h"]
    source = document(package["sourceManifest"])
    expected = document(package["candidateBundleManifest"])
    require(source["prepared"] == package["prepared"] and source["input"] == p["input"]
            and source["sourceManifest"] == p["stagedSource"]
            and source["dependencyManifest"] == c["old"]["dependencyManifest"]
            and source["resourceManifest"] == p["resourceManifest"]
            and package["bundleDelta"] == h["delta"](c["before"], expected)
            and package["binarySHA256"] == expected["Contents/MacOS/QwenLocal"]["sha256"],
            "Packaged source differs")
    require(package["archive"]["path"] == str(stage / 'outputs/Noiee-Build182.zip'),
            "Archive path differs")
    read_ref(package["archive"])
    guard(c)
    journal_path = stage / "installation-journal.json"
    journal = {"at": h["now"](), "build": 182, "state": "attempt-started",
               "packageSHA256": pin, "launched": False, "events": [],
               "bundleRestoration": {"scope": "bundle-only-while-closed", "dataRollback": False}}
    h["begin_attempt"](journal_path, journal)
    model_before = h["observe_model_listener"]()
    nonce = uuid.uuid4().hex
    target = private(APP.parent / ('.noiee-build182-update-' + nonce), create=True)
    journal["stage"] = str(target)
    h["save"](journal_path, journal)
    subprocess.run(["/usr/bin/ditto", "-x", "-k", package["archive"]["path"], str(target)],
                   check=True, timeout=120)
    candidate = target / APP.name
    require(sorted(x.name for x in target.iterdir()) == [APP.name]
            and h["manifest"](candidate) == expected
            and h["requirement"](candidate) == c["boundary"]["designatedRequirement"],
            "Extracted install candidate differs")
    h["verify_candidate"](candidate, source, c["boundary"], source["generatedEntries"])
    proof(c, stage, candidate, source)
    backup_parent = SUPPORT / "Saleh Uncensored Backups"
    private(backup_parent)
    backup = private(backup_parent / ('before-Noiee182-' + nonce), create=True)
    copies = {}
    for name, original in h["DATA_ROOTS"].items():
        guard(c)
        snapshot = c["boundary"]["dataManifests"][name]
        copies[name] = {"source": str(original), "present": snapshot is not None}
        if snapshot is not None:
            destination = backup / name
            subprocess.run(["/usr/bin/ditto", str(original), str(destination)],
                           check=True, timeout=600)
            require(h["manifest"](destination, True) == snapshot,
                    "Complete backup differs: " + name)
            h["verify_data"](c["boundary"])
            copies[name]["copy"] = str(destination)
    write(h, backup / "data-manifests.json", c["boundary"]["dataManifests"])
    write(h, backup / "backup-receipt.json",
          {"at": h["now"](), "dataIdentities": c["boundary"]["dataIdentities"],
           "backups": copies, "closedBoundary": c["cfg"]["closedBoundary"]})
    old_app = target / 'Build181-original.app'
    journal.update(rollbackApp=str(old_app), dataBackup=str(backup), state="prepared")
    h["save"](journal_path, journal)

    def check_data():
        require(h["boot_session"]() == c["boundary"]["bootSession"], "Boot changed")
        h["verify_data"](c["boundary"])

    def postcheck():
        info = plistlib.loads(raw(APP / "Contents/Info.plist"))
        require(info["CFBundleVersion"] == '182'
                and info["CFBundleName"] == info["CFBundleDisplayName"] == "Noiee"
                and info["CFBundleIdentifier"] == "com.saleh.qwenlocal.chat"
                and info["CFBundleExecutable"] == "QwenLocal"
                and h["requirement"](APP) == c["boundary"]["designatedRequirement"],
                "Installed Noiee identity/signature differs")
        proof(c, stage, APP, source)

    guard(c)
    h["replace_bundle"](APP, candidate, old_app, c["before"], expected,
                        journal_path, journal, check_data, lambda: stopped(c), postcheck)
    require(h["manifest"](old_app) == c["before"]
            and h["requirement"](old_app) == c["boundary"]["designatedRequirement"],
            "Signed rollback bundle differs")
    write(h, stage / "installation.json", {
        "at": h["now"](), "build": 182, "name": "Noiee", "packageSHA256": pin,
        "bundleMatchesPackage": True, "signatureVerified": True,
        "originalDataUnchanged": True, "rollbackApp": str(old_app), "backup": str(backup),
        "rollbackSignatureVerified": True, "backupReceipt": ref(backup / "backup-receipt.json"),
        "dataManifestReceipt": ref(backup / "data-manifests.json"),
        "closedBoundary": c["cfg"]["closedBoundary"], "launched": False,
        "modelListenerBefore": model_before, "modelListenerAfter": h["observe_model_listener"](),
        "nativeAcceptancePassed": False, "productionAcceptance": "pending",
    })
    print(json.dumps({"installed": True, "build": 182, "app": str(APP),
                      "installation": ref(stage / "installation.json"),
                      "backup": str(backup), "rollbackApp": str(old_app),
                      "launched": False, "productionAcceptance": "pending"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("freeze", "prepare", "build", "install"))
    parser.add_argument("--input", type=Path)
    parser.add_argument("--stage", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sha256")
    args = parser.parse_args()
    require(PROJECT == ROOT / "project", "Run the reviewed integrated project checkout")
    private(RELEASE)
    if args.phase == "freeze":
        require(args.output is not None and args.output.parent == RELEASE
                and args.output.suffix == ".json"
                and args.input is None and args.stage is None and args.sha256 is None,
                "Freeze requires only a new release-directory JSON output")
        h = load_helpers(RELEASE)
        write(h, args.output, source_snapshot())
        print(json.dumps({"sourceManifest": ref(args.output), "installed": False}))
        return
    require(type(args.sha256) is str and re.fullmatch("[0-9a-f]{64}", args.sha256)
            and args.output is None, "Exact input/receipt digest required")
    if args.phase == "prepare":
        require(args.input is not None and args.stage is None,
                "Prepare requires only --input and --sha256")
        prepare({"path": str(args.input), "sha256": args.sha256})
    else:
        require(args.stage is not None and args.input is None,
                "Build/install require only --stage and --sha256")
        (build if args.phase == "build" else install)(args.stage, args.sha256)


if __name__ == "__main__":
    main()
