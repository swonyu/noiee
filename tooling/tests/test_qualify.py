#!/usr/bin/env python3
"""Generated-fixture failure gates for the qualification evidence executor."""
from pathlib import Path
import importlib.util
import json
import os
import sys
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[1] / "qualify.py"
spec = importlib.util.spec_from_file_location("noiee_qualify_fixture", PATH)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

class QualificationChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="noiee-qualification-inputs-")
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / "project"
        (self.project / "source").mkdir(parents=True)
        (self.project / "source/app.js").write_text("generated fixture")
    def tearDown(self):
        self.temp.cleanup()
    def tap(self, **changes):
        values = dict(tests=3, **{"pass":3}, fail=0, cancelled=0, skipped=0, todo=0)
        values.update(changes)
        return "TAP version 13\n" + "".join("# %s %s\n" % row for row in values.items())
    def suite(self):
        value = q.Suite.__new__(q.Suite)
        value.project = self.project
        value.source = self.project / "source"
        value.output = q.create_output(self.project, None, "test-")
        value.evidence = value.output / "evidence"
        value.evidence.mkdir(mode=0o700)
        value.originals, value.retained = {}, []
        value.started_ns = 0
        return value
    def test_tap_counts_actual_completed_cases(self):
        self.assertEqual(q.tap_counts(self.tap()), 3)
    def test_tap_refuses_browser_skip_or_cancellation(self):
        for changes in (dict(skipped=1), dict(cancelled=1), dict(todo=1), dict(fail=1)):
            with self.assertRaises(RuntimeError):
                q.tap_counts(self.tap(**changes))
    def test_tap_refuses_missing_or_duplicate_summaries(self):
        for text in (self.tap().replace("# skipped 0\n", ""), self.tap() + "# pass 99\n"):
            with self.assertRaises(RuntimeError):
                q.tap_counts(text)
    def test_unittest_does_not_count_skipped_as_passed(self):
        self.assertEqual(q.unittest_counts("Ran 7 tests in 0.04s\n\nOK\n"), 7)
        for ending in ("OK (skipped=1)", "FAILED (errors=1)", "OK (expected failures=1)"):
            with self.assertRaises(RuntimeError):
                q.unittest_counts("Ran 7 tests in 0.04s\n\n" + ending + "\n")
    def test_executor_preserves_actual_nonzero_exit(self):
        log = self.root / "failed.log"
        result = q.execute([sys.executable, "-c", "print('not a passing run');raise SystemExit(7)"],
                           log, self.root, os.environ.copy(), timeout=10)
        self.assertEqual(result["exitCode"], 7)
        self.assertIn("not a passing run", log.read_text())
        self.assertEqual(result["log"], q.ref(log))
    def test_retained_evidence_is_exact_exclusive_copy(self):
        suite = self.suite()
        original = self.project / "fixture.json"
        original.write_text('{"generated":true}\n')
        saved = suite.retain(original, q.digest(original.read_bytes()))
        self.assertNotEqual(saved["path"], str(original))
        self.assertEqual(Path(saved["path"]).read_bytes(), original.read_bytes())
        self.assertEqual(suite.retain(original), saved)
        self.assertEqual(len(suite.retained), 1)
    def test_browser_hardlink_exception_is_exact_and_pinned(self):
        suite = self.suite()
        executable = self.root / "fixture-browser"
        executable.write_bytes(b"generated launcher fixture")
        os.link(executable, self.root / "second-link")
        old = q.CHROME_LAUNCHER
        q.CHROME_LAUNCHER = executable
        try:
            with self.assertRaises(RuntimeError):
                q.read_regular(executable)
            with self.assertRaises(RuntimeError):
                suite.retain(executable)
            saved = suite.retain(executable, q.digest(executable.read_bytes()))
            self.assertEqual(Path(saved["path"]).stat().st_nlink, 1)
            self.assertEqual(Path(saved["path"]).read_bytes(), executable.read_bytes())
        finally:
            q.CHROME_LAUNCHER = old
    def test_wrong_evidence_digest_is_rejected_before_copy(self):
        suite = self.suite()
        original = self.project / "fixture.json"
        original.write_text("{}")
        with self.assertRaises(RuntimeError):
            suite.retain(original, "0" * 64)
        self.assertEqual(list(suite.evidence.iterdir()), [])
    def test_unknown_external_evidence_is_not_read(self):
        suite = self.suite()
        outside = self.root / "outside.json"
        outside.write_text("{}")
        with self.assertRaises(RuntimeError):
            suite.retain(outside)
        self.assertEqual(list(suite.evidence.iterdir()), [])
    def test_linked_source_is_rejected(self):
        external = self.root / "outside.js"
        external.write_text("fixture")
        (self.project / "source/linked.js").symlink_to(external)
        with self.assertRaises(RuntimeError):
            q.source_pins(self.project)
    def test_linked_dependencies_are_excluded_without_reading(self):
        (self.project / "source/node_modules").symlink_to(self.root / "does-not-exist")
        self.assertEqual(set(q.source_pins(self.project)), {"app.js"})
    def test_output_cannot_overwrite_or_escape_artifacts(self):
        output = q.create_output(self.project, None, "test-")
        for requested in (output, self.root / "outside"):
            with self.assertRaises(RuntimeError):
                q.create_output(self.project, requested, "unused-")
    def test_raw_report_wrong_source_and_stale_receipt_are_rejected(self):
        suite = self.suite()
        raw_dir = self.project / ".artifacts/raw-run"
        raw_dir.mkdir()
        path = raw_dir / "RESULT.json"
        path.write_text(json.dumps({"sourceDirectory":"/wrong/source", "passed":1, "failed":0}))
        pointer = json.dumps({"report":str(path)})
        with self.assertRaises(RuntimeError):
            suite.raw_report(pointer)
        path.write_text(json.dumps({"sourceDirectory":str(suite.source), "passed":1, "failed":0}))
        suite.started_ns = path.stat().st_mtime_ns + 1
        with self.assertRaises(RuntimeError):
            suite.raw_report(pointer)

if __name__ == "__main__":
    unittest.main(verbosity=2)
