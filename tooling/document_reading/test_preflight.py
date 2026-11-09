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


if __name__ == '__main__':
    unittest.main()
