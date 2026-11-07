#!/usr/bin/env python3
"""Generated-fixture checks for immutable build records and read-only backup inventory."""
from pathlib import Path
import importlib.util, json, os, sys, tempfile, unittest
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

builder = module("noiee_build_native_fixture", ROOT / "tooling/build_native.py")
backups = module("noiee_backup_inventory_fixture", ROOT / "tooling/backup_inventory.py")

class ToolingChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="noiee-tools-", dir=ROOT / ".artifacts")
        self.root = Path(self.temporary.name).resolve()
    def tearDown(self):
        self.temporary.cleanup()
    def test_build_receipts_never_overwrite(self):
        first = self.root / "receipt.json"
        builder.save_new(first, {"binary": "first"})
        original = first.read_bytes()
        with self.assertRaises(FileExistsError):
            builder.save_new(first, {"binary": "second"})
        self.assertEqual(first.read_bytes(), original)
    def test_native_source_manifest_excludes_dependencies_without_reading_them(self):
        source = self.root / "source"; source.mkdir()
        (source / "App.swift").write_text("fixture")
        (source / "node_modules").symlink_to(self.root / "does-not-exist", target_is_directory=True)
        self.assertEqual(set(builder.source_manifest(source)), {"App.swift"})
    def test_linked_source_file_is_refused(self):
        source = self.root / "source"; source.mkdir()
        outside = self.root / "outside"; outside.write_text("not a source")
        (source / "App.swift").symlink_to(outside)
        with self.assertRaises(RuntimeError):
            builder.source_manifest(source)
    def test_inventory_covers_all_stores_without_opening_originals(self):
        root = self.root / "backups"; root.mkdir()
        backup = root / "before-fixture"; backup.mkdir()
        rows = {}
        for name in backups.STORES:
            copied = backup / name
            if name == "preferences.plist":
                copied.write_bytes(b"fixture")
            else:
                copied.mkdir()
            rows[name] = {"source":"/never-open-original/" + name, "present":True, "copy":str(copied)}
        receipt = backup / "backup-receipt.json"
        receipt.write_text(json.dumps({"at":"fixture","backups":rows,"closedBoundary":{"path":"/not-read","sha256":"0"*64}}))
        before = receipt.read_bytes()
        observed = backups.inventory(root)
        self.assertEqual(observed["entryCount"], 1)
        row = observed["entries"][0]
        self.assertTrue(row["receiptDeclaresAllFourStores"])
        self.assertTrue(all(item["copyMetadataMatches"] for item in row["coverage"].values()))
        self.assertFalse(row["restoreVerified"])
        self.assertFalse(observed["originalStoresOpened"])
        self.assertEqual(receipt.read_bytes(), before)
    def test_inventory_does_not_follow_backup_links(self):
        root = self.root / "backups"; root.mkdir()
        (root / "linked").symlink_to(self.root / "does-not-exist", target_is_directory=True)
        observed = backups.inventory(root)["entries"][0]
        self.assertEqual(observed["status"], "linked_or_non_directory_entry_skipped")
    def test_inventory_distinguishes_missing_copy_and_unknown_coverage(self):
        root = self.root / "backups"; root.mkdir()
        backup = root / "before-fixture"; backup.mkdir()
        (backup / "backup-receipt.json").write_text(json.dumps({"backups":{"Qwen Local":{"present":True,"copy":str(backup / "Qwen Local")}}}))
        row = backups.inventory(root)["entries"][0]
        self.assertFalse(row["receiptDeclaresAllFourStores"])
        self.assertFalse(row["coverage"]["Qwen Local"]["copyMetadataMatches"])
        self.assertFalse(row["coverage"]["WebKit"]["declared"])
    def test_inventory_rejects_linked_receipt(self):
        root = self.root / "backups"; root.mkdir()
        backup = root / "before-fixture"; backup.mkdir()
        external = self.root / "external.json"; external.write_text('{"backups":{}}')
        (backup / "backup-receipt.json").symlink_to(external)
        row = backups.inventory(root)["entries"][0]
        self.assertEqual(row["status"], "receipt_unreadable_or_unrecognized")

if __name__ == "__main__":
    (ROOT / ".artifacts").mkdir(mode=0o700, exist_ok=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ToolingChecks)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({"passed": result.testsRun-len(result.failures)-len(result.errors),
                      "failed":len(result.failures)+len(result.errors),"scope":"generated fixtures only"}))
    raise SystemExit(not result.wasSuccessful())
