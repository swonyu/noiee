"""Synthetic metadata tests only: NOT Docling conversion or performance tests."""
import unittest
from preflight import assess


class PreflightTests(unittest.TestCase):
    def test_matching_metadata_never_claims_conversion(self):
        result = assess((3, 14, 8), 'arm64', {'docling': '2.149.0', 'docling-slim': '2.149.0'})
        self.assertTrue(result['metadata_matches_review'])
        self.assertFalse(result['conversion_verified'])
        self.assertFalse(result['production_ready'])
        self.assertEqual(len(result['remaining_gates']), 3)

    def test_missing_packages(self):
        self.assertEqual(len(assess((3, 14, 8), 'arm64', {})['blockers']), 2)

    def test_mismatched_version(self):
        self.assertFalse(assess((3, 14, 8), 'arm64', {'docling': '2.148.0', 'docling-slim': '2.149.0'})['metadata_matches_review'])

    def test_unreviewed_python(self):
        for version in [(3, 9, 9), (3, 15, 2), (4, 0, 0)]:
            self.assertIn('Python', assess(version, 'arm64', {})['blockers'][0])

    def test_unreviewed_architecture(self):
        self.assertIn('Architecture', assess((3, 14, 8), 'riscv64', {})['blockers'][0])

    def test_input_is_not_mutated(self):
        versions = {'docling': None}
        assess((3, 14, 8), 'x86_64', versions)
        self.assertEqual(versions, {'docling': None})

# Diagnostic behavior tests remain independent of any installed converter.
class InspectTests(unittest.TestCase):
    def test_missing_distribution_is_reported(self):
        from unittest.mock import patch
        import importlib.metadata
        from preflight import inspect
        with patch('preflight.importlib.metadata.version', side_effect=importlib.metadata.PackageNotFoundError), patch('preflight.platform.machine', return_value='arm64'):
            result = inspect()
        self.assertEqual(result['packages'], {'docling': None, 'docling-slim': None})
        self.assertFalse(result['metadata_matches_review'])

    def test_slim_mismatch(self):
        from unittest.mock import patch
        from preflight import inspect
        with patch('preflight.importlib.metadata.version', side_effect=['2.149.0', '2.148.0']), patch('preflight.sys.version_info', (3,14,8)), patch('preflight.platform.machine', return_value='arm64'):
            result = inspect()
        self.assertEqual(len(result['blockers']), 1)
        self.assertIn('docling-slim', result['blockers'][0])

    def test_supported_version_boundaries(self):
        versions = {'docling':'2.149.0', 'docling-slim':'2.149.0'}
        for version in [(3,10,0), (3,14,99)]:
            self.assertTrue(assess(version, 'arm64', versions)['metadata_matches_review'])

    def test_cli_is_json_not_a_readiness_exit_gate(self):
        import json, pathlib, subprocess, sys
        proc = subprocess.run([sys.executable, '-B', str(pathlib.Path(__file__).with_name('preflight.py'))], capture_output=True, text=True, timeout=10, check=True)
        result = json.loads(proc.stdout)
        self.assertEqual(result['kind'], 'document-reading-metadata-preflight-v1')
        self.assertFalse(result['production_ready'])
        self.assertFalse(result['conversion_verified'])


if __name__ == '__main__':
    unittest.main()
