#!/usr/bin/env python3
"""Compile native Noiee code into an exclusive artifact directory; never sign or install."""
from pathlib import Path
import argparse, datetime, hashlib, json, os, stat, subprocess, sys, tempfile, time

FRAMEWORKS = ("AppKit", "WebKit", "UniformTypeIdentifiers", "ScreenCaptureKit",
              "ApplicationServices", "Contacts", "Security", "ImageIO", "PDFKit")
TARGET = "arm64-apple-macos15.2"

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_stable(path):
    path = Path(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("Expected a regular single-link build input: " + str(path))
    value = path.read_bytes()
    after = path.lstat()
    keys = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode")
    if len(value) != before.st_size or any(getattr(before,k) != getattr(after,k) for k in keys):
        raise RuntimeError("Build input changed during read: " + str(path))
    return value

def reference(path):
    path = Path(path).resolve(strict=True)
    data = read_stable(path)
    return {"path": str(path), "sha256": digest(data), "bytes": len(data)}

def save_new(path, value):
    data = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

def command_output(command, timeout=20):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=True,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    return result.stdout.strip()

def source_manifest(source):
    result = {}
    for parent, directories, filenames in os.walk(source, followlinks=False):
        parent = Path(parent)
        for name in list(directories):
            path = parent / name
            if path == source / "node_modules":
                directories.remove(name)
            elif path.is_symlink():
                raise RuntimeError("Unexpected linked source directory: " + str(path))
        for name in sorted(filenames):
            path = parent / name
            if path == source / "node_modules":
                continue
            data = read_stable(path)
            result[path.relative_to(source).as_posix()] = {
                "sha256": digest(data), "bytes": len(data),
                "mode": stat.S_IMODE(path.lstat().st_mode),
            }
    if not result:
        raise RuntimeError("Native source is empty")
    return dict(sorted(result.items()))

def git_state(project):
    top = command_output(["/usr/bin/git", "-C", str(project), "rev-parse", "--show-toplevel"])
    if Path(top).resolve(strict=True) != project:
        raise RuntimeError("--project must name the Git checkout root")
    return {
        "commit": command_output(["/usr/bin/git", "-C", str(project), "rev-parse", "HEAD"]),
        "status": command_output(["/usr/bin/git", "-C", str(project), "status", "--porcelain=v1", "--untracked-files=all"]),
    }

def collect_toolchain():
    compiler = Path(command_output(["/usr/bin/xcrun", "--find", "swiftc"])).absolute()
    sdk = Path(command_output(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"])).resolve(strict=True)
    settings = next((sdk / name for name in ("SDKSettings.json", "SDKSettings.plist") if (sdk / name).is_file()), None)
    if settings is None:
        raise RuntimeError("SDK settings identity is unavailable")
    return {
        "compiler": reference(compiler), "compilerInvocation": str(compiler),
        "compilerVersion": command_output([str(compiler), "--version"]),
        "sdkPath": str(sdk),
        "sdkVersion": command_output(["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"]),
        "sdkSettings": reference(settings),
        "xcodeVersion": command_output(["/usr/bin/xcodebuild", "-version"]),
        "developerDirectory": command_output(["/usr/bin/xcode-select", "-p"]),
        "hostVersion": command_output(["/usr/bin/sw_vers", "-productVersion"]),
        "target": TARGET,
    }

def run_logged(command, log, timeout):
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        try:
            result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
            return result.returncode
        finally:
            stream.flush()
            os.fsync(stream.fileno())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--build", type=int, required=True)
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--development", action="store_true",
                        help="Permit dirty sources, while marking the artifact ineligible for release.")
    args = parser.parse_args()
    project = args.project.resolve(strict=True)
    if args.build < 1:
        parser.error("--build must be positive")
    source = project / "source"
    state = git_state(project)
    if state["status"] and not args.development:
        raise RuntimeError("Commit the exact source/tooling first, or use --development for an ineligible development artifact.")
    output_root = (args.output_root or project / ".artifacts/native").absolute()
    output_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    if output_root.resolve(strict=True) != output_root or stat.S_IMODE(output_root.stat().st_mode) & 0o077:
        raise RuntimeError("Output root must be a canonical private directory")
    artifact = Path(tempfile.mkdtemp(prefix="build%s-" % args.build, dir=output_root))
    artifact.chmod(0o700)
    started = time.monotonic()
    record = {
        "schemaVersion": 2, "build": args.build,
        "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sourceDirectory": str(source), "sourceCommit": state["commit"],
        "development": args.development, "gitStatus": state["status"],
        "releaseEligible": False, "signed": False, "installed": False,
        "appLaunched": False, "modelInvoked": False,
        "builder": reference(Path(__file__).resolve()),
    }
    code = 1
    try:
        before = source_manifest(source)
        native = sorted(name for name in before if name.endswith(".swift"))
        if not native:
            raise RuntimeError("No Swift source files")
        toolchain = collect_toolchain()
        module_cache = artifact / "module-cache"
        module_cache.mkdir(mode=0o700)
        binary = artifact / "QwenLocal"
        command = [toolchain["compilerInvocation"], "-O", "-sdk", toolchain["sdkPath"],
                   "-target", TARGET, "-parse-as-library", "-module-cache-path", str(module_cache)]
        for framework in FRAMEWORKS:
            command.extend(["-framework", framework])
        command.extend([str(source / name) for name in native] + ["-o", str(binary)])
        record.update(sourceManifest=before, nativeFiles={n: before[n]["sha256"] for n in native},
                      toolchain=toolchain, command=command)
        save_new(artifact / "build-input.json", record)
        print(json.dumps({"status": "compiling", "artifact": str(artifact), "nativeFiles": len(native)}), flush=True)
        compiler_log = artifact / "compiler.log"
        code = run_logged(command, compiler_log, timeout=600)
        record.update(compilerExit=code, compilerLog=reference(compiler_log))
        if code == 0:
            binary.chmod(0o700)
            record["binary"] = reference(binary)
            check_command = [str(binary), "--check-computer"]
            check_log = artifact / "self-check.log"
            code = run_logged(check_command, check_log, timeout=60)
            output = read_stable(check_log)
            if len(output) > 65_536:
                raise RuntimeError("Native self-check output exceeds its reviewed receipt bound")
            record.update(selfCheckCommand=check_command, selfCheckExit=code,
                          selfCheckLog=reference(check_log), selfCheckOutput=output.decode("utf-8"))
        if source_manifest(source) != before or git_state(project) != state:
            raise RuntimeError("Source/commit changed during native compilation")
        if reference(Path(__file__).resolve()) != record["builder"]:
            raise RuntimeError("Builder changed during native compilation")
        if str(Path(toolchain["compilerInvocation"]).resolve(strict=True)) != toolchain["compiler"]["path"] or reference(toolchain["compiler"]["path"]) != toolchain["compiler"] or reference(toolchain["sdkSettings"]["path"]) != toolchain["sdkSettings"]:
            raise RuntimeError("Compiler/SDK identity changed during native compilation")
        record["sourceStableDuringBuild"] = True
        record["releaseEligible"] = code == 0 and not args.development and not state["status"]
    except Exception as error:
        record["error"] = str(error)
        code = 1
    record["durationSeconds"] = round(time.monotonic() - started, 3)
    record["exitCode"] = code
    receipt = artifact / "native-build.json"
    save_new(receipt, record)
    print(json.dumps({"receipt": reference(receipt), "artifact": str(artifact),
                      "exitCode": code, "releaseEligible": record["releaseEligible"]}), flush=True)
    return code

if __name__ == "__main__":
    raise SystemExit(main())
