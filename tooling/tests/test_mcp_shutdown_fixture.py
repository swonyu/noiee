"""Preserve historical MCP evidence while qualifying the expanded Stop contract."""
import hashlib
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tooling/integration/mcp-skills"
HISTORICAL_SHA = "43e95d450ead231e87a018af1b45d3f2c4d4ab4e8baf9f59a48cd6b92a56562b"
SUCCESSOR = "recovery-external-shutdown-check.mjs.in"
OLD_KEYS = "['coding','command','git','inference','schedules','tools','worktrees']"
NEW_KEYS = "['coding','command','externalArtifacts','externalRuntime','git','inference','schedules','tools','worktrees']"
TAIL = "assert.deepEqual(effects,{network:0,childProcess:0,originalStore:0});assert.equal(mcpFixture.calls,0);"


class MCPShutdownFixtureTests(unittest.TestCase):
    def setUp(self):
        self.original = (FIXTURES / "templates/recovery-check.mjs.in").read_text()
        self.successor = (FIXTURES / "templates" / SUCCESSOR).read_text()
        self.manifest = json.loads((FIXTURES / "TEMPLATES.json").read_text())

    def test_historical_template_is_byte_identical(self):
        self.assertEqual(hashlib.sha256(self.original.encode()).hexdigest(), HISTORICAL_SHA)

    def test_all_original_assertions_survive_only_declared_adaptations(self):
        # Require the whole original fixture prefix, not just its test labels or
        # a subset of assertions. The one changed key list remains exact.
        original_prefix, tail = self.original.split(TAIL)
        expected = original_prefix.replace(
            "{nativeSignature}=await import(SOURCE+'/agent.mjs')",
            "{nativeSignature,toolRoutes}=await import(SOURCE+'/agent.mjs')",
        ).replace("all seven closure results", "all nine closure results").replace(
            "assert.deepEqual(Object.keys(closed.value.results).sort()," + OLD_KEYS + ");",
            "assert.deepEqual(Object.keys(closed.value.results).sort()," + NEW_KEYS + ");"
            "assert.deepEqual(closed.value.results.externalArtifacts,{stopped:true});"
            "assert.deepEqual(closed.value.results.externalRuntime,{stopped:true});",
        )
        self.assertEqual(self.successor.split("// Successor coverage:")[0], expected)
        self.assertEqual(self.successor.split(TAIL)[1], tail)

    def test_successor_provenance_is_explicit_and_routes_once(self):
        rows = [row for row in self.manifest["files"]
                if row.get("generatedName", row["template"].removesuffix(".in")) == "recovery-check.mjs"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["template"], SUCCESSOR)
        self.assertEqual(row["predecessorTemplate"], "recovery-check.mjs.in")
        self.assertEqual(row["predecessorSHA256"], HISTORICAL_SHA)
        self.assertEqual(row["originSHA256"], HISTORICAL_SHA)
        self.assertEqual(row["sha256"], hashlib.sha256(self.successor.encode()).hexdigest())
        self.assertTrue(row["adaptation"])
        self.assertIs(self.manifest["existingBehavioralAssertionsPreserved"], True)

    def test_successor_exact_key_sets_and_independent_drains(self):
        self.assertIn("const allClosureKeys=" + NEW_KEYS + ";", self.successor)
        self.assertIn("const departureClosureKeys=['command','externalArtifacts','externalRuntime','git','inference','tools','worktrees'];", self.successor)
        self.assertIn("assert.deepEqual(Object.keys(result.value.results).sort(),keys);", self.successor)
        self.assertIn("for(const operation of ['stop','shutdown','depart'])", self.successor)
        self.assertIn("for(const releaseFirst of ['download','runtime'])", self.successor)
        self.assertIn("assert.deepEqual(disk,status.value.record);", self.successor)

    def test_current_gate_requires_expanded_exact_counts(self):
        runner = (FIXTURES / "run.py").read_text()
        self.assertIn('"mcp-recovery-lifecycle","recovery-check.mjs",31', runner)
        self.assertIn("passed==expected and failed==0", runner)
        self.assertIn('"scope":"83 fresh generated', runner)
        self.assertIn('"mcp-skills": 83', (ROOT / "tooling/qualify181.py").read_text())
        # Historical release contracts have not been retroactively revised.
        for name in ["qualify177.py", "qualify178.py", "qualify179.py", "qualify180.py"]:
            self.assertIn('"mcp-skills": 77', (ROOT / "tooling" / name).read_text())


if __name__ == "__main__":
    unittest.main()
