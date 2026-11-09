"""Offline checks of real retained observations; no rerun, install or inference."""
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).parent
RESULT = ROOT/'trial_result'


class TrialResultTests(unittest.TestCase):
    def setUp(self):
        self.receipt = json.loads((RESULT/'receipt.json').read_text())
        self.data = json.loads((RESULT/'observations.json').read_text())

    def test_real_stage_hashes_match_exact_plan(self):
        staged = json.loads((RESULT/'verified-wheels.json').read_text())
        plan = json.loads((ROOT/'runtime_plan/minimal-wheel-plan.json').read_text())
        expected = {r['filename']: (r['sha256'], r['bytes']) for r in plan['packages']}
        actual = {r['filename']: (r['sha256'], r['bytes']) for r in staged['packages']}
        self.assertEqual(actual, expected)
        self.assertTrue(all(r['verified'] for r in staged['packages']))
        self.assertEqual(staged['received_bytes'], 70944225)
        self.assertLess(staged['elapsed_seconds'], 120)

    def test_installed_versions_exact_except_venv_bootstrap_pip(self):
        normalize = lambda name: name.lower().replace('_','-')
        installed = {normalize(r['name']):r['version'] for r in json.loads((RESULT/'installed-packages.json').read_text())}
        planned = {normalize(r['name']):r['version'] for r in json.loads((ROOT/'runtime_plan/minimal-wheel-plan.json').read_text())['packages']}
        self.assertEqual(installed.pop('pip'), '26.2.1')
        self.assertEqual(installed, planned)

    def test_network_denial_and_measured_bounds(self):
        probe = json.loads((RESULT/'network-probe.json').read_text())['network_probe']
        self.assertTrue(all(p['denied'] and p['errno']==1 for p in probe.values()))
        for step in self.receipt['steps']:
            self.assertEqual(step['status'], 'complete')
            self.assertLessEqual(step['output_bytes'], 1024*1024)
            self.assertLessEqual(step['peak_sampled_rss_bytes'], 2*1024**3)
            self.assertLess(step['elapsed_seconds'], 120 if step['name'] in ('stage','venv','install') else 60)
        self.assertFalse(self.receipt['disk_limit_exceeded'])
        self.assertLess(self.receipt['peak_sampled_scratch_bytes'], 1024**3)

    def test_conversion_outputs_reproduce_original_hashes(self):
        steps = {s['name']:s for s in self.receipt['steps']}
        for name, observation in self.data['observations'].items():
            raw = (json.dumps(observation)+'\n').encode()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), steps['convert-'+name]['output_sha256'])
            self.assertEqual(observation['status'], 'success')
        child_hash = hashlib.sha256((RESULT/'measured_source/trial_child.py.txt').read_bytes()).hexdigest()
        self.assertEqual(child_hash, self.receipt['conversion_child_sha256'])

    def test_pdf_limits_and_office_tables_are_not_overclaimed(self):
        comparisons = self.data['comparisons']
        for name in ['text.pdf','table.pdf','columns.pdf','image.pdf','blank.pdf']:
            self.assertTrue(comparisons[name]['matches_pdfkit_token_sequence'])
            self.assertEqual(comparisons[name]['native_table_count'],0)
        self.assertFalse(comparisons['columns.pdf']['column_major_order'])
        for name in ['image.pdf','blank.pdf']:
            self.assertTrue(comparisons[name]['text_empty'])
            self.assertIsNone(comparisons[name]['all_text_items_have_page_box'])
        for name in ['synthetic.docx','synthetic.pptx','synthetic.xlsx']:
            self.assertTrue(comparisons[name]['exact_expected_cell_texts_and_coordinates'])
        self.assertEqual(comparisons['synthetic.docx']['page_count_as_reported_not_invented'],0)

class TrialManifestTests(unittest.TestCase):
    def test_manifest_and_no_host_private_paths(self):
        manifest = json.loads((RESULT/'manifest.json').read_text())
        correction = json.loads((RESULT/'runner_correction.json').read_text())
        for row in manifest['files']:
            path = ROOT/correction['historical_source_snapshots'].get(row['path'], row['path'])
            self.assertEqual(path.stat().st_size, row['bytes'])
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), row['sha256'])
        for path in RESULT.glob('*.json'):
            self.assertNotIn('/Users/', path.read_text())
            self.assertNotIn('/private/', path.read_text())


if __name__ == '__main__':
    unittest.main()
