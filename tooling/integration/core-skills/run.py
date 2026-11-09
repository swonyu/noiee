#!/usr/bin/env python3
"""Offline current-source core skill fixtures; never open the app or user stores."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / "source"
PREDECESSOR = HERE.parent / "mcp-skills"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ref(path):
    return {"path": str(path), "sha256": sha(path)}


def pins():
    paths = [p for p in SOURCE.iterdir() if p.is_file() and not p.is_symlink()]
    paths += list((ROOT / "tooling/bundled-skills").rglob("SKILL.md"))
    paths += [ROOT / "tooling/bundled-skills/catalog.json", ROOT / "tooling/generate_project_skills.py", ROOT / "tooling/tests/test_project_skills_catalog.py"]
    paths += [p for p in HERE.iterdir() if p.is_file()]
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(paths)}


def replace_once(text, old, new):
    assert text.count(old) == 1, "Successor adaptation anchor changed"
    return text.replace(old, new, 1)


def tap_counts(text):
    counts = {}
    for key in ["tests", "pass", "fail", "cancelled", "skipped", "todo"]:
        values = re.findall(r"^# " + key + r" (\d+)$", text, re.M)
        if len(values) != 1:
            raise ValueError("Missing or duplicate TAP summary: " + key)
        counts[key] = int(values[0])
    if counts["tests"] != counts["pass"] or any(counts[key] for key in ["fail", "cancelled", "skipped", "todo"]) or re.search(r"^not ok\b|^ok\b[^\n]*#\s*(?:SKIP|TODO)\b", text, re.M | re.I):
        raise ValueError("TAP includes failed, skipped, cancelled or incomplete cases")
    return counts["pass"], counts["fail"]


def main():
    output = ROOT / ".artifacts/integration"
    output.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix="core-skills-", dir=output))
    cache = Path(tempfile.mkdtemp(prefix="NoieeCoreSkills-", dir=Path.home() / "Library/Caches"))
    for name in ["checks", "tmp", "native-fixtures", "skills", "swift-cache"]:
        (cache / name).mkdir(mode=0o700)
    checks = cache / "checks"
    before = pins()
    rows, adaptations = [], []
    result = {"schemaVersion": 1, "name": "core-skills", "sourceDirectory": str(SOURCE), "sourcePins": before,
              "fixtureDirectory": str(cache), "rows": rows, "adaptations": adaptations,
              "scope": "Offline generated native filesystem/session, signed Agent dispatch and mock Tools DOM checks. No model, installed app, real UI, network, accounts or original stores."}
    env = {key: os.environ[key] for key in ["HOME", "USER", "LOGNAME"] if key in os.environ}
    env.update(PATH="/opt/homebrew/bin:/usr/bin:/bin", LANG="C", TMPDIR=str(cache / "tmp") + "/", PYTHONDONTWRITEBYTECODE="1",
               NOIEE_TOOLS_FIXTURE_ROOT=str(cache), SALEH_SKILLS_FIXTURE_ROOT=str(cache / "skills"), NOIEE_CORE_SKILL_SOURCE=str(ROOT / "tooling/bundled-skills"))

    def run(name, command, expected=None, style="tap"):
        log = out / (name + ".log")
        with log.open("xb") as stream:
            call = subprocess.run(command, cwd=cache, env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, timeout=150)
        passed, failed = 0, 0
        text = log.read_text()
        if expected is not None and call.returncode == 0:
            if style == "native":
                value = json.loads(text)
                assert value["passed"] is True and value["checks"] == len(value["cases"]) == len(set(value["cases"]))
                passed = value["checks"]
            else:
                passed, failed = tap_counts(text)
        qualified = call.returncode == 0 and (expected is None or passed == expected and failed == 0)
        row = {"name": name, "command": command, "exitCode": call.returncode, "passed": passed, "failed": failed if qualified else max(failed, 1), "expected": expected, "qualified": qualified, "log": ref(log)}
        rows.append(row)
        print(json.dumps(row), flush=True)
        if not qualified:
            print(text[-12000:], flush=True)
            raise RuntimeError(name + " failed")

    try:
        manifest = json.loads((PREDECESSOR / "TEMPLATES.json").read_text())
        by_name = {item["template"]: item for item in manifest["files"]}
        ids = json.loads((ROOT / "tooling/bundled-skills/catalog.json").read_text())["ids"]
        for name in ["ProjectSkillsHarness.swift.in", "ProjectSkillsClientFixture.swift.in", "project-skills-agent-check.mjs.in", "project-skills-ui-grouped-check.mjs.in"]:
            original = PREDECESSOR / "templates" / name
            assert sha(original) == by_name[name]["sha256"], "Historical template changed"
            text = original.read_text().replace("../../source/", str(SOURCE) + "/")
            extra = None
            description = "Only import paths route to current source."
            if name == "ProjectSkillsHarness.swift.in":
                extra = HERE / "native-catalog-check.swift.in"
                text = replace_once(text, "        let output:[String:Any]=", extra.read_text() + "        let output:[String:Any]=")
                description = "All 26 historical native cases preserved; eight additional exact-catalog, request and per-skill lifecycle cases inserted before reporting."
            elif name == "project-skills-agent-check.mjs.in":
                extra = HERE / "agent-catalog-check.mjs.in"
                text = "import {PROJECT_SKILL_IDS} from '" + str(SOURCE / "agent.mjs") + "';\n" + text + extra.read_text()
                description = "All seven historical Agent cases preserved; two additional all-ID schema, signed routing and real native publication checks appended."
            elif name == "project-skills-ui-grouped-check.mjs.in":
                extra = HERE / "ui-catalog-check.mjs.in"
                text = replace_once(text, "['patch-verify','debug-one-cause','public-research'].map", json.dumps(ids) + ".map")
                text = replace_once(text, "children.length===3", "children.length===" + str(len(ids))) + extra.read_text()
                description = "All four historical grouped UI behaviors preserved; mock catalog/count expanded to six, with all-row exact-ID routing assertion appended."
            target = checks / name.removesuffix(".in").replace("-grouped", "")
            target.write_text(text)
            target.chmod(0o600)
            adaptations.append({"predecessor": ref(original), "generated": ref(target), "adaptation": description, **({"extension": ref(extra)} if extra else {})})
        run("catalog-synchronization", [sys.executable, "-B", str(ROOT / "tooling/generate_project_skills.py"), "--check"])
        run("catalog-generator-tests", [sys.executable, "-B", str(ROOT / "tooling/tests/test_project_skills_catalog.py")])
        node = str(Path("/opt/homebrew/bin/node").resolve(strict=True))
        run("agent-syntax", [node, "--check", str(SOURCE / "agent.mjs")])
        for fixture, binary in [("ProjectSkillsHarness.swift", "project-skills-native-fixture"), ("ProjectSkillsClientFixture.swift", "project-skills-native-client-fixture")]:
            run(binary + "-compile", ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-target", "arm64-apple-macos15.2", "-module-cache-path", str(cache / "swift-cache"), *[str(SOURCE / name) for name in ["CodingTemporary.swift", "HandoffFiles.swift", "CodingSkills.swift", "ProjectSkills.swift"]], str(checks / fixture), "-o", str(checks / binary)])
        run("core-skills-native", [str(checks / "project-skills-native-fixture"), str(cache / "native-fixtures"), str(ROOT / "tooling/bundled-skills")], 34, "native")
        run("core-skills-agent", [node, "--preserve-symlinks", "--test", "--test-reporter=tap", str(checks / "project-skills-agent-check.mjs")], 9)
        run("core-skills-ui", [node, "--preserve-symlinks", "--test", "--test-reporter=tap", str(checks / "project-skills-ui-check.mjs")], 5)
        assert pins() == before, "Inputs changed during fixture execution"
        for adaptation in adaptations:
            assert sha(Path(adaptation["predecessor"]["path"])) == adaptation["predecessor"]["sha256"]
        result.update(exitCode=0, passed=sum(row["passed"] for row in rows), failed=0, sourceUnchanged=True)
    except BaseException as error:
        result.update(exitCode=1, passed=sum(row["passed"] for row in rows), failed=1, error=str(error), sourceUnchanged=pins() == before)
    result["completedUTC"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    receipt = out / "RESULT.json"
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"result": str(receipt), "sha256": sha(receipt), "passed": result["passed"], "failed": result["failed"]}), flush=True)
    return result["exitCode"]


if __name__ == "__main__":
    sys.exit(main())
