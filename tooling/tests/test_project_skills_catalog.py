#!/usr/bin/env python3
"""Generator checks in copied, disposable inputs; no app or project installation."""
from pathlib import Path
import hashlib
import json
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ProjectSkillGenerationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="NoieeSkillGenerator-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "source").mkdir()
        (self.root / "tooling").mkdir()
        shutil.copytree(ROOT / "tooling/bundled-skills", self.root / "tooling/bundled-skills")
        for relative in ["tooling/generate_project_skills.py", "source/ProjectSkills.swift", "source/agent.mjs"]:
            shutil.copyfile(ROOT / relative, self.root / relative)

    def run_generator(self, *args):
        return subprocess.run([sys.executable, "-B", str(self.root / "tooling/generate_project_skills.py"), *args], capture_output=True, text=True, timeout=10)

    def test_checked_catalog_and_original_revisions(self):
        result = self.run_generator("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["skills"]), 6)
        for id, sha in {"patch-verify": "c70f1ccc96b7efc17262dceea09a26e110c57ca50bab260eadb3d57141edd53a", "debug-one-cause": "9d74e41e48f2294ae76a379ba520a5db5275311f4c767eba0bc431112a087805", "public-research": "d9e165be116a23ee6c60afd0532dcae2d0014c125e44d6d44087d011725ef406"}.items():
            self.assertEqual(hashlib.sha256((self.root / "tooling/bundled-skills" / id / "SKILL.md").read_bytes()).hexdigest(), sha)

    def test_markdown_drift_fails_without_rewriting_and_regenerates(self):
        file = self.root / "tooling/bundled-skills/file-work/SKILL.md"
        file.write_text(file.read_text() + "\nFixture edit.\n")
        native = self.root / "source/ProjectSkills.swift"
        before = native.read_bytes()
        result = self.run_generator("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Bundled skill drift", result.stderr)
        self.assertEqual(native.read_bytes(), before)
        self.assertEqual(self.run_generator().returncode, 0)
        self.assertNotEqual(native.read_bytes(), before)
        self.assertEqual(self.run_generator("--check").returncode, 0)

    def test_agent_id_drift_fails(self):
        file = self.root / "source/agent.mjs"
        file.write_text(file.read_text().replace('"file-work"', '"wrong-file-work"', 1))
        result = self.run_generator("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source/agent.mjs", result.stderr)

    def test_manifest_identity_and_extra_files_fail_closed(self):
        file = self.root / "tooling/bundled-skills/catalog.json"
        original = file.read_text()
        manifest = json.loads(original)
        manifest["ids"].append("file-work")
        file.write_text(json.dumps(manifest))
        self.assertNotEqual(self.run_generator("--check").returncode, 0)
        file.write_text(original)
        (file.parent / "file-work/execute.sh").write_text("Fixture only, never executed.\n")
        self.assertNotEqual(self.run_generator("--check").returncode, 0)

    def test_metadata_and_generated_region_fail_closed(self):
        file = self.root / "tooling/bundled-skills/file-work/SKILL.md"
        original = file.read_text()
        file.write_text(original.replace("name: file-work", "name: other-skill", 1))
        self.assertNotEqual(self.run_generator("--check").returncode, 0)
        file.write_text(original)
        native = self.root / "source/ProjectSkills.swift"
        native.write_text(native.read_text().replace("// END GENERATED PROJECT SKILLS", "// MISSING END", 1))
        self.assertNotEqual(self.run_generator("--check").returncode, 0)


class ProjectSkillReceiptTests(unittest.TestCase):
    def test_tap_parser_refuses_incomplete_or_duplicated_results(self):
        parse = runpy.run_path(str(ROOT / "tooling/integration/core-skills/run.py"))["tap_counts"]
        text = "# tests 9\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"
        self.assertEqual(parse(text), (9, 0))
        for invalid in [text + "# pass 9\n", text.replace("# tests 9", "# tests 10"), text.replace("# skipped 0", "# skipped 1"), text.replace("# cancelled 0", "# cancelled 1"), text.replace("# todo 0", "# todo 1"), text.replace("# fail 0", ""), "not ok 1 - hidden failure\n" + text]:
            with self.assertRaises(ValueError):
                parse(invalid)


if __name__ == "__main__":
    unittest.main()
