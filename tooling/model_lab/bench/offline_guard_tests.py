"""Adversarial gate controls. Run separately; not model or application scores."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import offline_receipts as evidence
import run_offline


def tap(count):
    return 'TAP version 13\n'+''.join(f'# Subtest: example {i}\nok {i} - example {i}\n' for i in range(1,count+1))+f'1..{count}\n# tests {count}\n# suites 0\n# pass {count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.0\n'


def lifecycle(name):
    end={'passed':True,'fixtureRoot':'/tmp/synthetic','productionAppStarted':False,'nativeExecutionExercised':False}
    prefix=''
    if name=='agent_budget':
        end['realModelCalls']=0
        prefix=json.dumps({'requestedActions':13,'observedEffects':13,'modelRequests':14,'status':'complete','budgetReached':False,'receipts':13})+'\n'
    return prefix+'\n'.join(evidence.MARKERS[name])+'\n'+json.dumps(end)+'\n'


class OfflineGuards(unittest.TestCase):
    def test_true_executable_cannot_qualify_as_node(self):
        with self.assertRaisesRegex(evidence.EvidenceError,'SHA256'):
            evidence.identify_runtime('/usr/bin/true','node',evidence.clean_environment())

    def test_fake_executable_with_plausible_markers_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'node'; p.write_text('#!/bin/sh\necho '+repr(tap(7))+'\n');p.chmod(0o700)
            with patch('offline_receipts.subprocess.run') as launch, self.assertRaises(evidence.EvidenceError):
                evidence.identify_runtime(p,'node',evidence.clean_environment())
            launch.assert_not_called()

    def test_runtime_probe_is_bound_to_path_hash_and_identity(self):
        pin={'path':'/reviewed/node','sha256':evidence.NODE_RUNTIME['sha256']}
        good={'path':pin['path'],'release':'node',**{k:evidence.NODE_RUNTIME[k] for k in ['version','platform','arch']}}
        for bad in ['', '{}', json.dumps({**good,'path':'/other/node'}), json.dumps({**good,'release':'fake'})]:
            with self.subTest(bad=bad), patch('offline_receipts.executable_pin',return_value=pin), patch('offline_receipts.subprocess.run',return_value=subprocess.CompletedProcess([],0,bad,'')), self.assertRaises(evidence.EvidenceError):
                evidence.identify_runtime(pin['path'],'node',{})
        with patch('offline_receipts.executable_pin',side_effect=[pin,{**pin,'sha256':'changed'}]), patch('offline_receipts.subprocess.run',return_value=subprocess.CompletedProcess([],0,json.dumps(good),'')), self.assertRaisesRegex(evidence.EvidenceError,'changed'):
            evidence.identify_runtime(pin['path'],'node',{})

    def test_interpreter_environment_is_not_inherited(self):
        injected={'NODE_OPTIONS':'--require /tmp/hostile.cjs','NODE_PATH':'/tmp',
                  'PYTHONPATH':'/tmp','PYTHONSTARTUP':'/tmp/start','DYLD_INSERT_LIBRARIES':'/tmp/lib','LD_PRELOAD':'/tmp/lib'}
        with patch.dict('os.environ',injected): env=evidence.clean_environment()
        self.assertFalse(set(injected)&set(env))
        self.assertEqual(set(env),{'PATH','HOME','TMPDIR','LC_ALL'})

    def test_tap_positive_controls_have_exact_counts(self):
        for name,count in evidence.COUNTS.items():
            if name!='grader_controls': self.assertEqual(evidence.validate_completion(name,tap(count))['tests'],count)

    def test_tap_empty_partial_zero_duplicate_skip_and_failed_controls(self):
        good=tap(7)
        bad=['',good[:good.index('1..')],tap(0),good+good,
             good.replace('ok 7 - example 7','ok 6 - example 6'),
             good.replace('ok 7 - example 7','ok 7 - example 7 # SKIP'),
             good.replace('# skipped 0','# skipped 1'),good.replace('# todo 0','# todo 1'),
             good.replace('ok 7 - example 7','not ok 7 - example 7'),
             good.replace('# tests 7','# tests 7\n# tests 7'),
             good.replace('1..7','1..6'),good.replace('example 7','example 6')]
        for value in bad:
            with self.subTest(value=value[-60:]),self.assertRaises(evidence.EvidenceError): evidence.validate_completion('stream_stop',value)

    def test_python_requires_full_unskipped_exact_count(self):
        good='.'*46+'\n----------------------------------------------------------------------\nRan 46 tests in 0.1s\n\nOK\n'
        self.assertEqual(evidence.validate_completion('grader_controls',good)['tests'],46)
        for bad in ['',good.replace('46','0'),good+'OK\n',good.replace('OK','OK (skipped=1)'),good.replace('OK','FAILED'),good[1:]]:
            with self.assertRaises(evidence.EvidenceError): evidence.validate_completion('grader_controls',bad)

    def test_lifecycle_requires_all_unique_markers_and_terminal_receipt(self):
        for name in evidence.MARKERS:
            good=lifecycle(name)
            self.assertEqual(evidence.validate_completion(name,good)['completed_markers'],5)
            for bad in ['',good+good,good.replace(evidence.MARKERS[name][0]+'\n',''),
                        good.replace('PASS ','PASS altered ',1),good.rsplit('\n',2)[0]+'\n',
                        good.replace('"passed": true','"passed": false'),
                        good.replace('"nativeExecutionExercised": false','"nativeExecutionExercised": true')]:
                with self.subTest(name=name),self.assertRaises(evidence.EvidenceError): evidence.validate_completion(name,bad)

    def test_log_tampering_and_tampered_digest_cannot_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'log';p.write_text(tap(7));digest=evidence.sha(p)
            self.assertEqual(evidence.verify_log(p,digest,'stream_stop')['tests'],7)
            p.write_text(tap(7).replace('# pass 7','# pass 0'))
            with self.assertRaisesRegex(evidence.EvidenceError,'changed'): evidence.verify_log(p,digest,'stream_stop')
            with self.assertRaises(evidence.EvidenceError): evidence.verify_log(p,evidence.sha(p),'stream_stop')

    def test_source_or_runtime_change_fails_whole_gate(self):
        fake={'path':'/fake','sha256':'pin'}
        for changed in ['source','runtime','missing_checks']:
            with tempfile.TemporaryDirectory() as tmp, patch('run_offline.CHECKS',[]), patch('run_offline.identify_runtime',return_value=fake), patch('run_offline.pins',side_effect=[{'source':'old'},{'source':'new' if changed=='source' else 'old'}]), patch('run_offline.executable_pin',return_value={**fake,'sha256':'changed' if changed=='runtime' else 'pin'}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(run_offline.main(['--node','/fake','--output-dir',tmp]),1)
                report=json.loads((Path(tmp)/'results.json').read_text())
                self.assertEqual(report['status'],'fail')
                self.assertFalse(report['source_unchanged'] if changed=='source' else report['runtimes_unchanged'] if changed=='runtime' else report['execution_complete'])


if __name__=='__main__': unittest.main(verbosity=2)
