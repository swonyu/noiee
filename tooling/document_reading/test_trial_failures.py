"""Fail-closed runner tests with injected outcomes only; no package/network work."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT/'research'))
import run_trial
import continue_trial
import trial_child


def outcome(status='complete'):
    return {'status': status, 'started': True, 'output': b'',
            'returncode': 0 if status == 'complete' else 2,
            'elapsed_seconds': .01, 'peak_sampled_rss_bytes': 10}


def layout(tmp):
    root = Path(tmp)/'repo/tooling/document_reading'
    (root/'research').mkdir(parents=True)
    (root/'runtime_plan').mkdir()
    for name in ['trial_stage.py','trial_child.py']:
        (root/'research'/name).write_text('# synthetic test placeholder, never executed\n')
    for name in ['minimal-wheel-plan.json','requirements-native.lock']:
        (root/'runtime_plan'/name).write_text('{}')
    baseline = Path(tmp)/'baseline'
    baseline.mkdir()
    (baseline/'receipt.json').write_text(json.dumps({'fixture_hashes':{},'extractions':{}}))
    return root, baseline


class StageFailureTests(unittest.TestCase):
    def test_each_failed_gate_returns_nonzero_and_stops(self):
        for index in range(5):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as tmp:
                root, baseline = layout(tmp)
                results = [outcome() for _ in range(index)] + [outcome('failed')]
                with patch.object(run_trial, 'ROOT', root), patch.object(run_trial, 'run_bounded', side_effect=results) as runner, contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(run_trial.main(baseline), 1)
                self.assertEqual(runner.call_count, index+1)

    def test_all_gates_return_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, baseline = layout(tmp)
            with patch.object(run_trial, 'ROOT', root), patch.object(run_trial, 'run_bounded', side_effect=[outcome() for _ in range(5)]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(run_trial.main(baseline), 0)

    def test_cli_preserves_nonzero_exit(self):
        for module in [run_trial, continue_trial]:
            with patch.object(module, 'main', return_value=1), patch.object(sys, 'argv', ['test','synthetic-directory']):
                with self.assertRaises(SystemExit) as raised:
                    module.cli()
                self.assertEqual(raised.exception.code, 1)


class ContinuationFailureTests(unittest.TestCase):
    def run_case(self, failure_index):
        with tempfile.TemporaryDirectory() as tmp:
            root, _ = layout(tmp)
            job = root.parents[1]/'.artifacts/docling-native-trial-test'
            (job/'fixtures').mkdir(parents=True)
            receipt = {'steps':[{'name':name,'status':'complete'} for name in
                       ['stage','venv','install','network-probe','import-probe']],
                       'fixture_hashes':{},'peak_sampled_scratch_bytes':0}
            (job/'receipt.json').write_text(json.dumps(receipt))
            (job/'fixtures/office-manifest.json').write_text('{}')
            count = 9 if failure_index is None else failure_index+1
            results = [outcome() for _ in range(count)]
            if failure_index is not None:
                results[-1] = outcome('failed')
            with patch.object(continue_trial, 'ROOT', root), patch.object(continue_trial, 'run_bounded', side_effect=results) as runner, contextlib.redirect_stdout(io.StringIO()):
                code = continue_trial.main(job)
            self.assertEqual(code, 0 if failure_index is None else 1)
            self.assertEqual(runner.call_count, count)
            saved = json.loads((job/'receipt.json').read_text())
            if failure_index is not None:
                self.assertEqual(saved['steps'][-1]['status'], 'failed')

    def test_failed_generation_and_each_conversion_stop(self):
        for index in range(9):
            with self.subTest(index=index):
                self.run_case(index)

    def test_all_conversions_return_zero(self):
        self.run_case(None)


class ChildStatusTests(unittest.TestCase):
    def test_only_success_returns_zero_and_partial_output_is_retained(self):
        for status in ['success','partial_success','failure','skipped','pending','unknown']:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                document = types.SimpleNamespace(pages={}, texts=[], tables=[])
                result = types.SimpleNamespace(status=types.SimpleNamespace(value=status), document=document, errors=[])
                converter = types.SimpleNamespace(convert=lambda *a, **kw: result)
                modules = {}
                for name in ['docling','docling.document_converter','docling.datamodel',
                             'docling.datamodel.pipeline_options','docling.datamodel.base_models']:
                    modules[name] = types.ModuleType(name)
                modules['docling.document_converter'].DocumentConverter = lambda **kw: converter
                modules['docling.document_converter'].NativePdfFormatOption = lambda **kw: object()
                modules['docling.datamodel.pipeline_options'].NativePdfPipelineOptions = lambda **kw: object()
                modules['docling.datamodel.base_models'].InputFormat = types.SimpleNamespace(PDF='pdf',DOCX='docx',PPTX='pptx',XLSX='xlsx')
                directory = Path(tmp)
                (directory/'fixtures').mkdir()
                (directory/'fixtures/text.pdf').write_bytes(b'authored test placeholder, not parsed')
                prior = Path.cwd()
                try:
                    os.chdir(directory)
                    with patch.dict(sys.modules, modules), contextlib.redirect_stdout(io.StringIO()):
                        code = trial_child.convert_synthetic('text.pdf')
                    self.assertEqual(code, 0 if status == 'success' else 2)
                    self.assertEqual(json.loads((directory/'text.pdf.result.json').read_text())['status'], status)
                finally:
                    os.chdir(prior)


if __name__ == '__main__':
    unittest.main()
