#!/usr/bin/env python3
"""Exercise startup diagnostics with generated processes/configs/sockets only."""
from pathlib import Path
import hashlib, json, os, subprocess, sys, tempfile

project = Path(__file__).resolve().parents[1]
source = project / "source"
artifacts = project / ".artifacts"
artifacts.mkdir(mode=0o700, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix="startup-check-", dir=artifacts)).resolve()
os.chmod(root, 0o700)
paths = [source/"StartupDiagnostics.swift", source/"OwnedRuntimePaths.swift",
         project/"tooling/tests/StartupDiagnosticsFixture.swift"]
pins = {str(p.relative_to(project)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
binary = root/"startup-fixture"
command = ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-target", "arm64-apple-macos15.2",
           "-module-cache-path", str(root/"module-cache"), *map(str, paths), "-o", str(binary)]
log = root/"compile.log"
with log.open("xb") as stream:
    built = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=120)
record = {"scope":"private generated fixtures; no installed app/model/original stores",
          "sourceDirectory":str(source), "sourcePins":pins,
          "compileCommand":command, "compilerExit":built.returncode,
          "compileLog":{"path":str(log),"sha256":hashlib.sha256(log.read_bytes()).hexdigest()}}
code = built.returncode
if code == 0:
    completed = subprocess.run([str(binary),str(root)],capture_output=True,text=True,timeout=30)
    code = completed.returncode
    output = root/"fixture.log"
    output.write_text(completed.stdout+completed.stderr)
    record.update(exitCode=code, command=[str(binary),str(root)],
                  log={"path":str(output),"sha256":hashlib.sha256(output.read_bytes()).hexdigest()})
    if code == 0:
        record["result"] = json.loads(completed.stdout.strip().splitlines()[-1])
record["sourceUnchanged"] = all(hashlib.sha256(p.read_bytes()).hexdigest() == pins[str(p.relative_to(project))] for p in paths)
if not record["sourceUnchanged"]:
    code = 1
receipt = root/"RESULT.json"
with receipt.open("x") as stream:
    json.dump(record,stream,indent=2);stream.write("\n")
print(json.dumps({"exitCode":code,"receipt":str(receipt),
                  "sha256":hashlib.sha256(receipt.read_bytes()).hexdigest(),"result":record.get("result")}))
raise SystemExit(code)
