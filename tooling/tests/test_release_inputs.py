"""Generated input-gate checks. No release phase, installed app, or original store is used."""
from pathlib import Path
import copy, hashlib, importlib.util, json, os, stat, sys, tempfile, unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ADAPTER = Path(__file__).resolve().parents[1] / "release_host.py"
spec = importlib.util.spec_from_file_location("noiee_release_input_fixture", ADAPTER)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Inputs(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="noiee-release-fixture-")
        self.root = Path(self.temporary.name).resolve()
        self.project = self.root / "project"
        self.source = self.project / "source"
        self.artifacts = self.project / ".artifacts"
        self.system = self.root / "generated-toolchain"
        for path in (self.source, self.artifacts, self.system, self.project / "tooling"):
            path.mkdir(parents=True, mode=0o700)
        self.files = {}
        for name, data in {"App.swift": b"// generated, never compiled\n",
                           "server.mjs": b"// generated, never run\n"}.items():
            path = self.source / name
            path.write_bytes(data)
            path.chmod(0o600)
            self.files[name] = {"sha256": release.sha(data), "bytes": len(data), "mode": 0o600}
        builder = self.project / "tooling/build_native.py"
        builder.write_bytes(b"# generated validator input, never executed\n")
        self.builder = release.ref(builder)
        self.frozen = {
            "gitCommit": "a" * 40, "files": self.files,
            "projectFiles": {"source/" + n: row for n, row in self.files.items()},
        }
        self.frozen["projectFiles"]["tooling/build_native.py"] = {
            "sha256": self.builder["sha256"], "bytes": builder.stat().st_size, "mode": 0o644}
        self.patches = [
            patch.object(release, "PROJECT", self.project),
            patch.object(release, "SOURCE", self.source),
            patch.object(release, "ARTIFACT_ROOTS", (self.artifacts,)),
            patch.object(release, "SYSTEM_BUILD_ROOTS", (self.system,)),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(self.temporary.cleanup)
        for item in self.patches:
            self.addCleanup(item.stop)
        self.serial = 0

    def save(self, path, value):
        data = value if type(value) is bytes else json.dumps(value).encode()
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o600)
        return {"path": str(path), "sha256": release.sha(data), "bytes": len(data)}

    def qualification(self):
        self.serial += 1
        base = self.artifacts / ("qualification-" + str(self.serial))
        suites = []
        for name in sorted(release.REQUIRED_SUITES):
            command = ["/usr/bin/python3", str(self.project / "tooling" / (name + ".py"))]
            log = self.save(base / (name + ".log"), b"GENERATED VALIDATOR FIXTURE ONLY\n")
            result = {
                "fixtureOnly": True, "sourceDirectory": str(self.source),
                "sourcePins": {n: r["sha256"] for n, r in self.files.items()},
                "sourceUnchanged": True, "exitCode": 0, "passed": 2, "failed": 0,
                "command": command, "log": log,
            }
            if name == "startup-diagnostics":
                result["result"] = {"passed": result.pop("passed"), "failed": result.pop("failed")}
                result["sourcePins"] = {"source/App.swift": self.files["App.swift"]["sha256"]}
            result_ref = self.save(base / (name + ".json"), result)
            suites.append({"name": name, "command": command, "exitCode": 0,
                           "passed": 2, "failed": 0, "scope": "generated validator fixture only",
                           "log": log, "result": result_ref})
        return {"schemaVersion": 1, "gitCommit": self.frozen["gitCommit"],
                "sourcePins": {n: r["sha256"] for n, r in self.files.items()},
                "sourceUnchanged": True, "suites": suites}

    def check_report(self, report):
        self.serial += 1
        ref = self.save(self.artifacts / ("aggregate-" + str(self.serial) + ".json"), report)
        return release.verify_reports({"qualification": ref}, self.frozen)

    def native(self):
        self.serial += 1
        base = self.artifacts / ("native-" + str(self.serial))
        compiler = self.save(self.system / "swiftc", b"generated compiler identity; never executed")
        sdk = self.system / "MacOSX.sdk"
        settings = self.save(sdk / "SDKSettings.json", b'{"fixtureOnly":true}')
        binary = self.save(base / "QwenLocal", b"generated binary identity; never executed")
        compiler_log = self.save(base / "compiler.log", b"")
        output = "\n".join(prefix + " fixture" for prefix in release.SELF_CHECK_PREFIXES) + "\n"
        self_log = self.save(base / "self-check.log", output.encode())
        toolchain = {
            "target": "arm64-apple-macos15.2", "compiler": compiler,
            "compilerInvocation": compiler["path"], "compilerVersion": "generated fixture",
            "sdkPath": str(sdk), "sdkVersion": "fixture", "sdkSettings": settings,
            "xcodeVersion": "fixture", "developerDirectory": str(self.system), "hostVersion": "fixture",
        }
        command = [compiler["path"], "-O", "-sdk", str(sdk), "-target", toolchain["target"],
                   "-parse-as-library", "-module-cache-path", str(base / "module-cache")]
        for framework in release.NATIVE_FRAMEWORKS:
            command.extend(["-framework", framework])
        command.extend([str(self.source / "App.swift"), "-o", binary["path"]])
        return base, {
            "fixtureOnly": True, "schemaVersion": 2, "build": 172,
            "sourceDirectory": str(self.source), "sourceCommit": self.frozen["gitCommit"],
            "sourceManifest": self.files, "nativeFiles": {"App.swift": self.files["App.swift"]["sha256"]},
            "gitStatus": "", "sourceStableDuringBuild": True, "releaseEligible": True, "development": False,
            "signed": False, "installed": False, "appLaunched": False, "modelInvoked": False,
            "compilerExit": 0, "selfCheckExit": 0, "exitCode": 0,
            "builder": self.builder, "binary": binary, "compilerLog": compiler_log,
            "selfCheckLog": self_log, "toolchain": toolchain, "command": command,
            "selfCheckCommand": [binary["path"], "--check-computer"], "selfCheckOutput": output,
        }

    def check_native(self, base, receipt):
        return release.verify_native(self.save(base / "native-build.json", receipt), self.frozen)

    def test_distinct_source_bound_suites_pass(self):
        result = self.check_report(self.qualification())
        self.assertEqual(set(result["passedBySuite"]), release.REQUIRED_SUITES)
        self.assertEqual(sum(result["passedBySuite"].values()), 14)

    def test_missing_suite_refused(self):
        q = self.qualification()
        q["suites"].pop()
        with self.assertRaisesRegex(RuntimeError, "Missing"):
            self.check_report(q)

    def test_duplicate_suite_refused(self):
        q = self.qualification()
        q["suites"].append(q["suites"][0])
        with self.assertRaisesRegex(RuntimeError, "duplicate"):
            self.check_report(q)

    def test_old_commit_refused(self):
        q = self.qualification()
        q["gitCommit"] = "b" * 40
        with self.assertRaisesRegex(RuntimeError, "commit"):
            self.check_report(q)

    def test_incomplete_source_pins_refused(self):
        q = self.qualification()
        q["sourcePins"].pop("server.mjs")
        with self.assertRaisesRegex(RuntimeError, "every"):
            self.check_report(q)

    def test_changed_source_pin_refused(self):
        q = self.qualification()
        q["sourcePins"]["server.mjs"] = "b" * 64
        with self.assertRaises(RuntimeError):
            self.check_report(q)

    def test_bool_pass_count_refused(self):
        q = self.qualification()
        q["suites"][0]["passed"] = True
        with self.assertRaises(RuntimeError):
            self.check_report(q)

    def test_zero_pass_count_refused(self):
        q = self.qualification()
        q["suites"][0]["passed"] = 0
        with self.assertRaises(RuntimeError):
            self.check_report(q)

    def test_failed_execution_refused(self):
        q = self.qualification()
        q["suites"][0]["exitCode"] = 1
        with self.assertRaises(RuntimeError):
            self.check_report(q)

    def test_count_disagreement_refused(self):
        q = self.qualification()
        q["suites"][0]["passed"] = 3
        with self.assertRaisesRegex(RuntimeError, "counts"):
            self.check_report(q)

    def test_reused_log_refused(self):
        q = self.qualification()
        q["suites"][1]["log"] = q["suites"][0]["log"]
        with self.assertRaisesRegex(RuntimeError, "distinct"):
            self.check_report(q)

    def test_foreign_reference_refused(self):
        q = self.qualification()
        q["suites"][0]["log"] = self.save(self.root / "foreign.log", b"fixture")
        with self.assertRaisesRegex(RuntimeError, "outside"):
            self.check_report(q)

    def test_changed_log_refused(self):
        q = self.qualification()
        Path(q["suites"][0]["log"]["path"]).write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "changed"):
            self.check_report(q)

    def test_symlink_reference_refused(self):
        q = self.qualification()
        old = q["suites"][0]["log"]
        link = self.artifacts / "linked.log"
        link.symlink_to(old["path"])
        q["suites"][0]["log"] = {**old, "path": str(link)}
        with self.assertRaisesRegex(RuntimeError, "Noncanonical"):
            self.check_report(q)

    def test_constituent_failure_refused(self):
        q = self.qualification()
        row = q["suites"][0]
        actual = json.loads(Path(row["result"]["path"]).read_bytes())
        actual["rows"] = [{"command": ["/usr/bin/false"], "exitCode": 1, "passed": 2, "failed": 0}]
        row["result"] = self.save(Path(row["result"]["path"]), actual)
        with self.assertRaisesRegex(RuntimeError, "constituent"):
            self.check_report(q)

    def test_command_substitution_refused(self):
        q = self.qualification()
        q["suites"][0]["command"] = ["/usr/bin/true"]
        with self.assertRaisesRegex(RuntimeError, "command"):
            self.check_report(q)

    def test_unchanged_fetch_payloads_pass(self):
        old = {name: {"sha256": release.sha(name.encode())} for name in release.FETCH_IMMUTABLE}
        release.verify_immutable_payloads(copy.deepcopy(old), old)

    def test_each_changed_fetch_payload_refused(self):
        old = {name: {"sha256": release.sha(name.encode())} for name in release.FETCH_IMMUTABLE}
        for name in release.FETCH_IMMUTABLE:
            with self.subTest(name=name):
                changed = copy.deepcopy(old)
                changed[name]["sha256"] = "b" * 64
                with self.assertRaisesRegex(RuntimeError, "Fetch payload/contract changed"):
                    release.verify_immutable_payloads(changed, old)

    def test_missing_fetch_payload_refused(self):
        old = {name: {"sha256": release.sha(name.encode())} for name in release.FETCH_IMMUTABLE}
        missing = copy.deepcopy(old)
        missing.pop(next(iter(release.FETCH_IMMUTABLE)))
        with self.assertRaises(RuntimeError):
            release.verify_immutable_payloads(missing, old)

    def test_native_exact_provenance_passes(self):
        base, receipt = self.native()
        value, refs = self.check_native(base, receipt)
        self.assertTrue(value["fixtureOnly"])
        self.assertEqual(len(refs), 4)

    def test_development_native_refused(self):
        base, receipt = self.native()
        receipt["development"] = True
        with self.assertRaisesRegex(RuntimeError, "Release-eligible"):
            self.check_native(base, receipt)

    def test_native_dirty_commit_refused(self):
        base, receipt = self.native()
        receipt["gitStatus"] = " M source/App.swift"
        with self.assertRaises(RuntimeError):
            self.check_native(base, receipt)

    def test_native_wrong_commit_refused(self):
        base, receipt = self.native()
        receipt["sourceCommit"] = "b" * 40
        with self.assertRaises(RuntimeError):
            self.check_native(base, receipt)

    def test_native_missing_swift_refused(self):
        base, receipt = self.native()
        receipt["nativeFiles"] = {}
        with self.assertRaises(RuntimeError):
            self.check_native(base, receipt)

    def test_native_command_omission_refused(self):
        base, receipt = self.native()
        receipt["command"].remove(str(self.source / "App.swift"))
        with self.assertRaisesRegex(RuntimeError, "command"):
            self.check_native(base, receipt)

    def test_native_selfcheck_log_changed_refused(self):
        base, receipt = self.native()
        Path(receipt["selfCheckLog"]["path"]).write_bytes(b"FAIL fixture\n")
        with self.assertRaises(RuntimeError):
            self.check_native(base, receipt)

    def test_native_selfcheck_receipt_mismatch_refused(self):
        base, receipt = self.native()
        receipt["selfCheckOutput"] += "EXTRA\n"
        with self.assertRaisesRegex(RuntimeError, "self-check output"):
            self.check_native(base, receipt)

    def test_native_claimed_launch_refused(self):
        base, receipt = self.native()
        receipt["appLaunched"] = True
        with self.assertRaises(RuntimeError):
            self.check_native(base, receipt)

    def test_native_foreign_binary_refused(self):
        base, receipt = self.native()
        receipt["binary"] = self.save(self.root / "foreign-binary", b"fixture")
        with self.assertRaisesRegex(RuntimeError, "outside"):
            self.check_native(base, receipt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
