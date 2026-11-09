"""Generated input-gate checks. No release phase, installed app, or original store is used."""
from pathlib import Path
import copy, hashlib, importlib.util, json, os, stat, sys, tempfile, unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ADAPTER = Path(__file__).resolve().parents[1] / "release_host181.py"
spec = importlib.util.spec_from_file_location("noiee_release_input_fixture", ADAPTER)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
CAPTURE = ADAPTER.with_name("capture_closed_boundary181.py")
capture_spec = importlib.util.spec_from_file_location("noiee_closed_boundary_fixture", CAPTURE)
capture = importlib.util.module_from_spec(capture_spec)
capture_spec.loader.exec_module(capture)
QUALIFY = ADAPTER.with_name("qualify181.py")
qualify_spec = importlib.util.spec_from_file_location("noiee_release_qualification_fixture", QUALIFY)
qualify = importlib.util.module_from_spec(qualify_spec)
qualify_spec.loader.exec_module(qualify)


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
            "fixtureOnly": True, "schemaVersion": 2, "build": 181,
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
        self.assertEqual(sum(result["passedBySuite"].values()), 2 * len(release.REQUIRED_SUITES))

    def test_missing_suite_refused(self):
        for name in sorted(release.REQUIRED_SUITES):
            with self.subTest(missing=name):
                q = self.qualification()
                q["suites"] = [row for row in q["suites"] if row["name"] != name]
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

    def test_previous_build_native_receipt_refused(self):
        base, receipt = self.native()
        receipt["build"] = 180
        with self.assertRaisesRegex(RuntimeError, "Release-eligible"):
            self.check_native(base, receipt)

    def test_capture_and_adapter_bind_the_same_predecessor(self):
        self.assertEqual(hashlib.sha256(CAPTURE.read_bytes()).hexdigest(), release.CAPTURE_SHA)
        self.assertEqual(release.OLD, capture.STAGE180)
        self.assertEqual(release.RELEASE, capture.RELEASE)
        self.assertEqual(release.OLD_PINS["candidate-receipt.json"], capture.PACKAGE_SHA)
        self.assertEqual(release.OLD_PINS["candidate-bundle-manifest.json"], capture.BUNDLE_SHA)
        self.assertEqual(release.HELPER_PINS["build-candidate.py"], capture.HELPER_SHA)

    def capture_fixture(self, build):
        # Every observed byte and callback is generated. The actual app path is
        # passed only to these fakes; no process, store or release phase is used.
        from unittest.mock import Mock
        import plistlib
        bundle = {"generated-entry": {"sha256": "b" * 64}}
        catalog = {"generated-owner": True}
        snapshot = Mock(return_value=({"generated-store": None}, {"generated-identity": None}))
        h = {"boot_session": lambda: "generated-boot", "requirement": lambda _: "generated-signature",
             "manifest": lambda _: bundle, "data_snapshot": snapshot}
        info = plistlib.dumps({"CFBundleIdentifier": "com.saleh.qwenlocal.chat",
                              "CFBundleExecutable": "QwenLocal", "CFBundleVersion": build})
        with patch.object(capture, "require_stopped"), patch.object(capture, "catalog_state", return_value=catalog), \
                patch.object(capture, "regular_bytes", return_value=info):
            try:
                return capture.observe(h, bundle), snapshot
            except RuntimeError:
                snapshot.assert_not_called()
                raise

    def test_capture_observes_build180_fixture(self):
        value, snapshot = self.capture_fixture('180')
        self.assertEqual(value["installedBuild"], '180')
        self.assertEqual(value["dataManifests"], {"generated-store": None})
        snapshot.assert_called_once_with()

    def test_capture_refuses_wrong_build_before_store_observation(self):
        for build in ('172', '173', '174', '179', '181', "unknown"):
            with self.subTest(build=build), self.assertRaisesRegex(RuntimeError, "Unexpected predecessor"):
                self.capture_fixture(build)

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


class WorkflowResults(unittest.TestCase):
    def named(self, **changes):
        value = {"schemaVersion": 1, "name": "coding-goals", "passed": 2,
                 "failed": 0, "checks": ["generated create", "generated pause"]}
        value.update(changes)
        return json.dumps(value)

    def test_new_workflow_suites_are_required_by_runner_and_adapter(self):
        for name in ("catalog", "goals", "submission-origin"):
            self.assertIn(name, qualify.SUITES)
            self.assertIn(name, release.REQUIRED_SUITES)
            self.assertIn(name, qualify.SCOPES)

    def test_named_result_retains_actual_assertions(self):
        for name in ("coding-goals", "coding-catalog", "coding-catalog-ui"):
            with self.subTest(name=name):
                count, extra = qualify.named_check_result(
                    "generated fixture output\n" + self.named(name=name), name)
                self.assertEqual(count, 2)
                self.assertEqual(extra["assertions"], ["generated create", "generated pause"])

    def test_named_result_refuses_missing_or_duplicate_execution(self):
        for name in ("coding-goals", "coding-catalog", "coding-catalog-ui"):
            for text in (self.named(name="unrelated"),
                         self.named(name=name) + "\n" + self.named(name=name)):
                with self.subTest(name=name, text=text), self.assertRaises(RuntimeError):
                    qualify.named_check_result(text, name)

    def test_named_result_refuses_incomplete_or_invalid_assertions(self):
        for name in ("coding-goals", "coding-catalog", "coding-catalog-ui"):
            for changes in ({"passed": True}, {"passed": 1}, {"failed": 1}, {"failed": False},
                            {"schemaVersion": True}, {"checks": []}, {"checks": ["repeat", "repeat"]},
                            {"checks": ["generated create", " "]}, {"checks": ["generated create", {}]}):
                with self.subTest(name=name, changes=changes), self.assertRaises(RuntimeError):
                    qualify.named_check_result(self.named(name=name, **changes), name)

    def engine(self, **changes):
        checks = ["generated guarded dispatch", "coding-engine checks passed",
                  "coding-engine error scope checks passed"]
        value = {"name": "coding-engine", "fullSuite": True,
                 "passed": len(checks), "checks": checks}
        value.update(changes)
        return self.named(**value)

    def test_engine_result_retains_fresh_completed_group_count(self):
        count, extra = qualify.engine_check_result(self.engine())
        self.assertEqual(count, 3)
        self.assertEqual(len(extra["assertions"]), 3)
        self.assertIs(extra["fullSuite"], True)

    def test_engine_result_refuses_partial_or_untyped_completion(self):
        for full in (False, None, 1, "true"):
            with self.subTest(full=full), self.assertRaisesRegex(RuntimeError, "complete shared-engine"):
                qualify.engine_check_result(self.engine(fullSuite=full))

    def test_engine_result_refuses_truncated_harness_or_cleanup(self):
        for marker in ("coding-engine checks passed", "coding-engine error scope checks passed"):
            with self.subTest(marker=marker), self.assertRaisesRegex(RuntimeError, "complete shared-engine"):
                qualify.engine_check_result(self.engine(passed=1, checks=[marker]))

    def submission(self, browser=False, **changes):
        value = {"passed": True, "installedAppTouched": False}
        if browser:
            value.update(submissionOrigin=True, checks=["generated composition", "generated duplicate"],
                         oldChatAndDraftsPreserved=True, nativeAccessibilityExercised=False, upstreamCalls=1)
        else:
            value.update(cases=["generated receipt", "generated provenance"], realModelCalls=0)
        value.update(changes)
        return json.dumps(value)

    def test_submission_results_retain_actual_assertions(self):
        for browser in (False, True):
            count, extra = qualify.submission_result(self.submission(browser), browser=browser)
            self.assertEqual(count, 2)
            self.assertEqual(len(extra["assertions"]), 2)

    def test_submission_results_refuse_failure_ambiguous_and_duplicate_assertions(self):
        for browser in (False, True):
            key = "checks" if browser else "cases"
            for text in (self.submission(browser, passed=False),
                         self.submission(browser, installedAppTouched=True),
                         self.submission(browser, **{key: []}),
                         self.submission(browser, **{key: ["duplicate", "duplicate"]}),
                         self.submission(browser) + "\n" + self.submission(browser)):
                with self.subTest(browser=browser, text=text), self.assertRaises(RuntimeError):
                    qualify.submission_result(text, browser=browser)

    def test_submission_receipts_refuse_live_or_untyped_model_counts(self):
        for count in (1, False, "0"):
            with self.subTest(count=count), self.assertRaises(RuntimeError):
                qualify.submission_result(self.submission(realModelCalls=count))

    def test_submission_browser_requires_preservation_and_truthful_scope(self):
        for changes in ({"oldChatAndDraftsPreserved": False}, {"nativeAccessibilityExercised": True},
                        {"submissionOrigin": False}, {"upstreamCalls": False}, {"upstreamCalls": -1}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                qualify.submission_result(self.submission(True, **changes), browser=True)


class SuccessorContract(unittest.TestCase):

    def test_full_coding_ui_counts_one_scenario_and_rejects_partial_or_duplicate_marker(self):
        marker = qualify.CODING_UI_COMPLETION
        count, extra = qualify.coding_ui_result("fixture output\n" + marker + "\n")
        self.assertEqual(count, 1)
        self.assertEqual(extra["completedScenarios"], ["full-coding-ui"])
        for text in ("", marker[:-1], marker + "\n" + marker,
                     marker + "\nPASS coding UI: partial", "prefix " + marker):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                qualify.coding_ui_result(text)

    def test_presentation_dispatch_keeps_parity_and_full_suite_without_flags(self):
        from types import SimpleNamespace
        suite = qualify.Suite.__new__(qualify.Suite)
        suite.args = SimpleNamespace(suite="presentation")
        suite.project = Path("/synthetic/project")
        suite.source = suite.project / "source"
        suite.node = "/synthetic/node"
        calls = []
        suite.case = lambda *args: calls.append(args)
        with patch.object(qualify, "require_scripts") as checked:
            suite.run()
        checked.assert_called_once_with([suite.project / "tests/inline-rendering-check.mjs"])
        self.assertEqual(calls[0][1], [suite.node, "--preserve-symlinks", str(suite.project / "tests/inline-rendering-check.mjs")])
        self.assertIs(calls[0][2], qualify.inline_rendering_result)
        self.assertEqual([row[0] for row in calls], ["inline-rendering", "presentation", "workbench",
            "coding-result-state", "coding-parity", "coding-ui-full"])
        self.assertEqual(calls[-1][1], [suite.node, "--preserve-symlinks",
                                      str(suite.source / "coding-ui-check.mjs")])
        self.assertIs(calls[-1][2], qualify.coding_ui_result)



    def test_inline_completion_counts_one_and_requires_exact_single_final_marker(self):
        marker = qualify.INLINE_RENDERING_COMPLETION
        count, extra = qualify.inline_rendering_result("fixture output\n" + marker + "\n")
        self.assertEqual(count, 1)
        self.assertEqual(extra["completedScenarios"], ["full-inline-rendering"])
        self.assertIn("not individual assertions", extra["countUnit"])
        for text in ("", marker[:-1], marker + "\n" + marker,
                     marker + "\ninline-rendering-check: PASS partial", "prefix " + marker,
                     marker + "\nlate output", marker + "\n\n"):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                qualify.inline_rendering_result(text)

    def test_missing_or_nonregular_inline_fixture_refuses_before_any_command(self):
        from types import SimpleNamespace
        for kind in ("missing", "directory", "symlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                suite = qualify.Suite.__new__(qualify.Suite)
                suite.args = SimpleNamespace(suite="presentation")
                suite.project = Path(directory).resolve()
                suite.source = suite.project / "source"
                suite.node = "/synthetic/node"
                path = suite.project / "tests/inline-rendering-check.mjs"
                path.parent.mkdir()
                if kind == "directory":
                    path.mkdir()
                elif kind == "symlink":
                    target = suite.project / "fixture.mjs"
                    target.write_text("// synthetic, never run\n")
                    path.symlink_to(target)
                with patch.object(suite, "case") as invoke:
                    with self.assertRaises((RuntimeError, FileNotFoundError)):
                        suite.run()
                    invoke.assert_not_called()

    def test_model_fixture_retains_current_source_verbatim_without_legacy_rewrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            suite = qualify.Suite.__new__(qualify.Suite)
            suite.source = root / "source"
            suite.cache = root / "cache"
            suite.source.mkdir()
            suite.cache.mkdir()
            suite.retain = lambda path: qualify.ref(path)
            # Approved Build181 picker syntax that broke historical adaptation.
            raw = ("label: id, contextLength: 131072, loaded: true\n"
                   "new Set(['context-compaction.js','model-policy.js'])\n").encode()
            original = suite.source / "model-picker-ui-check.mjs"
            original.write_bytes(raw)
            path = suite.model_fixture()
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(suite.fixture["originalSHA256"], qualify.digest(raw))
            self.assertEqual(suite.fixture["generated"]["sha256"], qualify.digest(raw))
            self.assertEqual(suite.fixture["changes"], [])
            self.assertIs(suite.fixture["assertionsChanged"], False)
            self.assertIs(suite.fixture["byteIdentical"], True)
            self.assertEqual(os.readlink(suite.cache / "node_modules"), str(suite.source / "node_modules"))


    def test_exact_installed_predecessor_is_selected(self):
        self.assertEqual(release.OLD.name, "Noiee180-e_lowahb")
        self.assertEqual(release.OLD_PINS, {
            "source-manifest.json": "1bd9eb8373205b5bf2861b2079182d7f10dd0d83bd84c6e9221cb3dd01bb353a",
            "candidate-bundle-manifest.json": "4ee21b56a7a3bcf13257b06ec9cabc9d504f4b3c05bf28b7f749c63c912e1782",
            "candidate-receipt.json": "dd0ed11426e7debb6d939d6ccc600be7bb9fe46f35106f795dd00cffc2a4570d",
        })
        self.assertEqual(capture.BINARY_SHA,
                         "6eb5b560ccc9c8b7e16ff74108018aeabbf004c89e9afe3a2fc41fded1a7f578")
        self.assertEqual(release.RELEASE.name, "build181")

    def test_model_suite_executes_complete_stream_regression_inventory(self):
        # Exercise runner dispatch with synthetic paths and an intercepted case
        # callback. Never launch Node/browser, models, or a release phase.
        from types import SimpleNamespace
        suite = qualify.Suite.__new__(qualify.Suite)
        suite.args = SimpleNamespace(suite="model-stabilization")
        suite.project = Path("/synthetic/project")
        suite.source = suite.project / "source"
        suite.node = "/synthetic/node"
        suite.env = {}
        fixture = Path("/synthetic/generated/model-picker-ui-check.mjs")
        suite.model_fixture = lambda: fixture
        calls = []
        suite.case = lambda *args: calls.append(args)
        with patch.object(qualify, "require_scripts") as checked:
            suite.run()
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[0][1], [suite.node, "--preserve-symlinks", "--test",
            "--test-reporter=tap", *map(str, [
                suite.source / "local-models-check.mjs",
                suite.source / "coding-model-check.mjs", fixture,
                suite.source / "coding-model-guards-check.mjs",
                suite.source / "model-stabilization-check.mjs",
                suite.source / "agent-cancel-check.mjs",
                suite.source / "agent-stream-check.mjs",
                suite.source / "agent-usage-check.mjs"])])
        self.assertEqual(calls[1][1], [suite.node, "--preserve-symlinks", "--test",
            "--test-reporter=tap", str(suite.source / "model-response-cleanup-check.mjs"),
            str(suite.source / "model-cleanup-routes-check.mjs")])
        self.assertIs(calls[1][2], qualify.cleanup_result)
        checked.assert_called_once_with([*map(Path, calls[0][1][4:]),
            *map(Path, calls[1][1][4:]), suite.source / "model-routing-check.mjs",
            suite.source / "model-endpoint-check.mjs"])
        self.assertEqual(calls[2][0], "model-routing")
        self.assertEqual(calls[3][1], [suite.node, "--preserve-symlinks",
                                     str(suite.source / "model-endpoint-check.mjs")])
        self.assertIs(calls[3][2], qualify.endpoint_result)

    def test_cleanup_completion_requires_exactly_eighteen_tests(self):
        def tap(count):
            return f"# tests {count}\n# pass {count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
        self.assertEqual(qualify.cleanup_result(tap(18))[0], 18)
        for text in ("", tap(0), tap(6), tap(12), tap(17), tap(19), tap(18) + tap(18),
                     tap(18).replace("# skipped 0", "# skipped 1")):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                qualify.cleanup_result(text)

    def test_missing_cleanup_script_refuses_before_any_command(self):
        from types import SimpleNamespace
        for missing in ("model-response-cleanup-check.mjs", "model-cleanup-routes-check.mjs"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                suite = qualify.Suite.__new__(qualify.Suite)
                suite.args = SimpleNamespace(suite="model-stabilization")
                suite.project = Path(directory).resolve()
                suite.source = suite.project / "source"
                suite.source.mkdir()
                suite.node = "/synthetic/node"
                suite.env = {}
                for name in ("local-models", "coding-model", "model-picker-ui", "coding-model-guards",
                             "model-stabilization", "agent-cancel", "agent-stream", "agent-usage",
                             "model-response-cleanup", "model-cleanup-routes", "model-routing", "model-endpoint"):
                    path = suite.source / (name + "-check.mjs")
                    if path.name != missing:
                        path.write_text("// synthetic fixture, never run\n")
                suite.model_fixture = lambda: suite.source / "model-picker-ui-check.mjs"
                with patch.object(suite, "case") as invoke, self.assertRaises(FileNotFoundError):
                    suite.run()
                invoke.assert_not_called()

    def test_required_script_rejects_directory_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / "fixture.mjs"
            path.write_text("// synthetic\n")
            qualify.require_scripts([path])
            link = root / "link.mjs"
            link.symlink_to(path)
            for invalid in (root, link):
                with self.subTest(path=invalid), self.assertRaises(RuntimeError):
                    qualify.require_scripts([invalid])

    def test_endpoint_completion_rejects_missing_duplicate_or_partial_marker(self):
        marker = "PASS 6 endpoint binding checks using actual engine composition and request handlers, synthetic inventory/inference only."
        self.assertEqual(qualify.endpoint_result(marker)[0], 6)
        for text in ("", marker + "\n" + marker, marker.replace("6 endpoint", "5 endpoint"), marker[:-1]):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                qualify.endpoint_result(text)

    def test_host_and_capture_guard_functions_are_preserved(self):
        import ast
        import re
        # Compare every function AST with the historical adapter, allowing only
        # release identity strings/numbers to advance. Helper pins stay exact.
        pins = {
            "4c80955042ce409d7712d396c8be4a3fe84dcf70bab7c80ca839a765d7d44ffd": capture.BUNDLE_SHA,
            "df3553bfb1db808d80be670516e66e25e009302602b27791b7d93551632e1a3f": capture.PACKAGE_SHA,
            "dd51eede87e657a6e9aad371a9454c89a69576d77871d5b42fa401a8469a9683": capture.BINARY_SHA,
        }
        def advance(text):
            return "".join(pins.get(part, part) if re.fullmatch("[a-f0-9]{64}", part)
                           else re.sub("180|179|178", lambda m: str(int(m[0]) + 1), part)
                           for part in re.split("([a-f0-9]{64})", text))
        def functions(text):
            return {node.name: ast.dump(node, include_attributes=False)
                    for node in ast.parse(text).body if isinstance(node, ast.FunctionDef)}
        for path in (ADAPTER, CAPTURE):
            with self.subTest(path=path.name):
                original = path.with_name(path.name.replace("181", "180")).read_text()
                self.assertEqual(functions(advance(original)), functions(path.read_text()))

    def test_historical_helper_pins_are_unchanged(self):
        import ast
        tree = ast.parse(ADAPTER.with_name("release_host180.py").read_text())
        assignments = {node.targets[0].id: node.value for node in tree.body
                       if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
        self.assertEqual(release.HELPER_PINS, ast.literal_eval(assignments["HELPER_PINS"]))
        self.assertEqual(release.RELEASE_NODE_SHA, ast.literal_eval(assignments["RELEASE_NODE_SHA"]))



class CoreSkillsResults(unittest.TestCase):
    def setUp(self):
        self.logs = {}
        self.catalog = json.dumps({"checked": True, "changed": [], "skills": [
            {"id": name, "sha256": "a" * 64} for name in qualify.CORE_SKILL_IDS]})
        self.rows = []
        for name, expected in qualify.CORE_SKILLS_ROWS.items():
            self.rows.append({"name": name, "exitCode": 0, "passed": expected or 0,
                              "failed": 0, "qualified": True, "expected": expected,
                              "command": ["/synthetic/fixture", name], "log": name})
            self.logs[name] = ""
            if name == "catalog-synchronization":
                self.logs[name] = self.catalog
            elif name == "catalog-generator-tests":
                self.logs[name] = "Ran 6 tests in 0.1s\n\nOK\n"
            elif name == "core-skills-native":
                self.logs[name] = json.dumps({"passed": True, "checks": 34,
                                             "cases": ["case-" + str(n) for n in range(34)]})
            elif expected:
                self.logs[name] = self.tap(expected)
        self.raw = {"schemaVersion": 1, "name": "core-skills", "exitCode": 0,
                    "passed": 48, "failed": 0, "sourceUnchanged": True, "rows": self.rows}

    def tap(self, count):
        return f"# tests {count}\n# pass {count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"

    def check(self):
        return qualify.core_skills_result(self.raw, self.logs.__getitem__)

    def test_complete_exact_core_skills_contract(self):
        self.assertEqual(self.check(), 48)
        self.assertEqual(qualify.catalog_consistency_result(self.catalog)[0], 1)

    def test_catalog_rejects_drift_missing_duplicate_or_wrong_ids(self):
        original = json.loads(self.catalog)
        for key, value in [("checked", False), ("changed", ["agent.mjs"]),
                           ("skills", original["skills"][:-1]),
                           ("skills", original["skills"][:5] + original["skills"][:1]),
                           ("skills", list(reversed(original["skills"])) )]:
            bad = {**original, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                qualify.catalog_consistency_result(json.dumps(bad))
        for text in ("", self.catalog + "\n" + self.catalog):
            with self.assertRaises(RuntimeError):
                qualify.catalog_consistency_result(text)

    def test_rejects_bad_overall_counts_types_and_stability(self):
        for key, value in [("schemaVersion", True), ("passed", 47), ("passed", 49),
                           ("failed", 1), ("exitCode", False), ("sourceUnchanged", False)]:
            with self.subTest(key=key, value=value), patch.dict(self.raw, {key: value}):
                with self.assertRaises(RuntimeError): self.check()

    def test_rejects_missing_duplicate_reordered_or_extra_rows(self):
        for rows in (self.rows[:-1], self.rows + self.rows[:1], self.rows[::-1],
                     self.rows[:-1] + self.rows[:1]):
            with patch.dict(self.raw, {"rows": rows}), self.assertRaises(RuntimeError):
                self.check()

    def test_rejects_each_unqualified_or_uncertain_constituent(self):
        for row in self.rows:
            for key, value in [("qualified", False), ("exitCode", 1), ("failed", 1),
                               ("passed", 99), ("command", []), ("skipped", 1),
                               ("cancelled", 1), ("todo", 1), ("uncertain", 1)]:
                with self.subTest(row=row["name"], key=key), patch.dict(row, {key: value}):
                    with self.assertRaises(RuntimeError): self.check()

    def test_rejects_native_missing_or_duplicate_cases(self):
        for cases in (["one"] * 34, [str(n) for n in range(33)]):
            with patch.dict(self.logs, {"core-skills-native": json.dumps({
                    "passed": True, "checks": 34, "cases": cases})}), self.assertRaises(RuntimeError):
                self.check()

    def test_rejects_partial_duplicate_skipped_or_uncertain_tap(self):
        for name, count in [("core-skills-agent", 9), ("core-skills-ui", 5)]:
            good = self.tap(count)
            for text in (self.tap(count - 1), good + good, good.replace("# skipped 0", "# skipped 1"),
                         good.replace("# cancelled 0", "# cancelled 1"),
                         good.replace("# todo 0", "# todo 1"), good + "ok 1 - test # SKIP\n",
                         good + "not ok 1 - test\n", ""):
                with self.subTest(name=name, text=text), patch.dict(self.logs, {name: text}):
                    with self.assertRaises(RuntimeError): self.check()

    def test_generator_tests_must_all_six_complete(self):
        for text in ("Ran 5 tests in 0.1s\n\nOK\n", "Ran 6 tests in 0.1s\n\nOK (skipped=1)\n", ""):
            with patch.dict(self.logs, {"catalog-generator-tests": text}), self.assertRaises(RuntimeError):
                self.check()

    def test_mcp_dispatch_preserves_historical_and_new_gates(self):
        from types import SimpleNamespace
        suite = qualify.Suite.__new__(qualify.Suite)
        suite.args = SimpleNamespace(suite="mcp-skills")
        suite.project = Path("/synthetic/project")
        suite.source = suite.project / "source"
        suite.python = "/synthetic/python"
        suite.node = "/synthetic/node"
        calls = []
        suite.case = lambda *args: calls.append(args)
        with patch.object(qualify, "require_scripts") as preflight:
            suite.run()
        self.assertEqual([row[0] for row in calls], ["generated-catalog-consistency", "core-skills", "mcp-skills"])
        self.assertEqual(calls[0][1][-1], "--check")
        self.assertIn("tooling/integration/core-skills/run.py", calls[1][1][-1])
        self.assertEqual(len(qualify.SUITES), 11)
        self.assertEqual(len(release.REQUIRED_SUITES), 10)
        self.assertEqual(len(preflight.call_args.args[0]), 3)

    def test_missing_new_script_fails_before_any_mcp_command(self):
        from types import SimpleNamespace
        for missing in ("tooling/generate_project_skills.py", "tooling/tests/test_project_skills_catalog.py",
                        "tooling/integration/core-skills/run.py"):
            with tempfile.TemporaryDirectory() as directory:
                suite = qualify.Suite.__new__(qualify.Suite)
                suite.args = SimpleNamespace(suite="mcp-skills")
                suite.project = Path(directory).resolve()
                suite.python = "/synthetic/python"
                for name in ("tooling/generate_project_skills.py", "tooling/tests/test_project_skills_catalog.py",
                             "tooling/integration/core-skills/run.py"):
                    if name != missing:
                        path = suite.project / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text("# never executed\n")
                with patch.object(suite, "case") as invoke, self.assertRaises(FileNotFoundError):
                    suite.run()
                invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
