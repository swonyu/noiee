"""Offline consistency checks of the proposed environment and public provenance."""
import gzip
import hashlib
import json
from pathlib import Path
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).parent


class RuntimePlanTests(unittest.TestCase):
    def test_exact_51_wheel_plan_matches_report(self):
        plan = json.loads((ROOT / 'runtime_plan/minimal-wheel-plan.json').read_text())
        report = json.loads(gzip.decompress((ROOT / 'runtime_plan/minimal-pip-report.json.gz').read_bytes()))
        hashes = {r['download_info']['archive_info']['hashes']['sha256'] for r in report['install']}
        self.assertEqual(len(plan['packages']), 51)
        self.assertEqual(plan['package_count'], 51)
        self.assertEqual(len(hashes), 51)
        self.assertEqual({r['sha256'] for r in plan['packages']}, hashes)
        self.assertEqual(sum(r['bytes'] for r in plan['packages']), 70944225)
        self.assertEqual(plan['total_wheel_bytes'], 70944225)
        for r in plan['packages']:
            self.assertGreater(r['bytes'], 0)
            self.assertEqual(urlsplit(r['wheel_url']).scheme, 'https')
            self.assertEqual(urlsplit(r['wheel_url']).hostname, 'files.pythonhosted.org')
            self.assertTrue(r['filename'].endswith('.whl'))

    def test_all_wheels_have_prior_notice_review_identity(self):
        plan = json.loads((ROOT / 'runtime_plan/minimal-wheel-plan.json').read_text())
        prior = json.loads((ROOT / 'evidence/resolved-inventory.json').read_text())
        hashes = {r['wheel_sha256_declared'] for r in prior['artifacts']}
        for row in plan['packages']:
            self.assertIn(row['sha256'], hashes)
            self.assertTrue(row['same_wheel_as_prior_notice_review'])
        names = {r['name'].lower() for r in plan['packages']}
        self.assertFalse(names & {'torch', 'torchvision', 'rapidocr', 'onnxruntime', 'easyocr', 'ocrmac', 'transformers'})

    def test_hash_lock_matches_plan(self):
        plan = json.loads((ROOT / 'runtime_plan/minimal-wheel-plan.json').read_text())
        actual = {line for line in (ROOT / 'runtime_plan/requirements-native.lock').read_text().splitlines() if line and not line.startswith('#')}
        expected = {f"{r['name']}=={r['version']} --hash=sha256:{r['sha256']}" for r in plan['packages']}
        self.assertEqual(actual, expected)

    def test_dictionary_identity_and_license_are_separate_from_weight_execution(self):
        p = json.loads((ROOT / 'runtime_plan/rapidocr-provenance.json').read_text())
        self.assertTrue(p['dictionary_byte_identity_verified'])
        self.assertIn('license: Apache License 2.0', p['license_evidence']['text'])
        self.assertEqual(hashlib.sha256(p['license_evidence']['text'].encode()).hexdigest(), p['license_evidence']['sha256'])
        dictionary = next(r for r in p['artifacts'] if r['role'] == 'dictionary')
        self.assertEqual(dictionary['declared_sha256'], 'b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d')
        sources = p['dictionary_upstream']['sources']
        self.assertEqual(next(r['sha256'] for r in sources if r['key']=='paddle_pinned_dictionary'), dictionary['declared_sha256'])
        self.assertTrue(dictionary['byte_hash_verified'])
        for r in p['artifacts']:
            if r['role'] != 'dictionary':
                self.assertFalse(r['downloaded_for_this_research'])
                self.assertFalse(r['byte_hash_verified'])


if __name__ == '__main__':
    unittest.main()
