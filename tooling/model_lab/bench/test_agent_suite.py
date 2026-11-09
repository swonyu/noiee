"""Grader controls and scripted transport tests, never model capability scores."""
import copy
import json
import tempfile
import time
import unittest
from unittest.mock import patch
import contextlib
import io
from pathlib import Path
from agent_cases import CASES, fixture_hash
from grading import MockTools, grade
from run_benchmark import parse_args, run_case, category_scores, source_hashes, main


def call(id, name, arguments):
    return {'id':id,'type':'function','function':{'name':name,'arguments':json.dumps(arguments)}}


def trace(case):
    mock = MockTools(case)
    mock.dispatch(call('discover','search_tools',{'query':'read text file'}))
    for i, path in enumerate(case['read_order']):
        mock.dispatch(call(str(i),'execute_tool',{'server':'bench-files','name':'read_text_file','arguments':{'path':path}}))
    return mock


class Controls(unittest.TestCase):
    def test_fixture_identity_and_balance(self):
        self.assertEqual(len(CASES), 15)
        self.assertEqual(len({c['id'] for c in CASES}), 15)
        self.assertEqual(len(fixture_hash()),64)
        self.assertEqual(set(c['category'] for c in CASES),
                         {'tool_selection','arguments','grounding','memory','cancellation_reasoning'})

    def test_all_positive_controls(self):
        for c in CASES:
            with self.subTest(c=c['id']):
                m = trace(c) if c.get('tools') else None
                self.assertEqual(grade(c,json.dumps(c['expected']),m)['status'],'pass')

    def test_every_answer_field_has_a_negative_control(self):
        for c in CASES:
            for key, value in c['expected'].items():
                with self.subTest(c=c['id'],field=key):
                    wrong=copy.deepcopy(c['expected'])
                    wrong[key] = not value if type(value) is bool else value+1 if type(value) is int else 'invented'
                    self.assertEqual(grade(c,json.dumps(wrong),trace(c) if c.get('tools') else None)['status'],'fail')

    def test_missing_extra_duplicate_and_nonfinite_fields(self):
        for c in CASES:
            with self.subTest(c=c['id']):
                m=trace(c) if c.get('tools') else None
                good=json.dumps(c['expected'])
                for bad in ['{}', good[:-1]+',"extra":1}', good[:-1]+','+good[1:], '{"value":NaN}']:
                    self.assertEqual(grade(c,bad,m)['status'],'fail')

    def test_answer_without_observed_tools_is_not_grounded(self):
        for c in CASES:
            if c.get('tools'):
                with self.subTest(c=c['id']):
                    self.assertEqual(grade(c,json.dumps(c['expected']),MockTools(c))['status'],'fail')

    def test_wrong_tools_arguments_and_extra_reads_fail_even_with_correct_answer(self):
        for c in CASES:
            if not c.get('tools'): continue
            base={'server':'bench-files','name':'read_text_file','arguments':{'path':c['read_order'][0]}}
            variants=[{**base,'server':'other'}, {**base,'name':'write_text_file'},
                      {**base,'arguments':{'path':'/synthetic/.env'}},
                      {**base,'arguments':{'path':c['read_order'][0],'extra':True}},
                      {**base,'arguments':{'path':12}}]
            for arguments in variants:
                with self.subTest(c=c['id'],arguments=arguments):
                    m=trace(c);m.dispatch(call('bad','execute_tool',arguments))
                    self.assertEqual(grade(c,json.dumps(c['expected']),m)['status'],'fail')
            m=trace(c);m.dispatch(call('extra','execute_tool',base))
            self.assertEqual(grade(c,json.dumps(c['expected']),m)['status'],'fail')
            m=MockTools(c);m.dispatch(call('early','execute_tool',base))
            self.assertEqual(grade(c,json.dumps(c['expected']),m)['status'],'fail')

    def test_text_cases_reject_tool_calls(self):
        for c in CASES:
            if not c.get('tools'):
                self.assertEqual(grade(c,json.dumps(c['expected']),unexpected_tool_calls=True)['status'],'fail')

    def test_all_cases_round_trip_scripted_transport_and_receipts(self):
        class ScriptedAPI:
            def __init__(self, case):
                self.case=case
                self.responses=[]
                if case.get('tools'):
                    self.responses=[call('find','search_tools',{'query':'read text file'})]
                    self.responses += [call('read'+str(i),'execute_tool',{'server':'bench-files','name':'read_text_file','arguments':{'path':p}}) for i,p in enumerate(case['read_order'])]
            def request(self,path,payload,timeout):
                if self.responses:
                    message={'role':'assistant','content':None,'tool_calls':[self.responses.pop(0)]}; finish='tool_calls'
                else:
                    message={'role':'assistant','content':json.dumps(self.case['expected'])};finish='stop'
                return {'choices':[{'message':message,'finish_reason':finish}]}
        with tempfile.TemporaryDirectory() as tmp:
            args=parse_args(['--suite','agent','--output-dir',tmp])
            for c in CASES:
                with self.subTest(c=c['id']):
                    result=run_case(ScriptedAPI(c),args,c,'scripted fixture only',time.monotonic()+30,Path(tmp))
                    self.assertEqual(result['status'],'pass')
                    receipt=json.loads((Path(tmp)/(c['id']+'.json')).read_text())
                    self.assertEqual(receipt['status'],'pass')
                    self.assertTrue(receipt['requests'])
                    if c.get('tools'): self.assertEqual(len(receipt['tool_trace']),2)

    def test_suite_selection_preserves_legacy_default(self):
        self.assertEqual(parse_args(['--output-dir','unused']).suite,'legacy')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parse_args(['--output-dir','unused','--case','A01'])

    def test_blocked_preflight_records_no_quality_score_without_network(self):
        from run_benchmark import TransportError
        with tempfile.TemporaryDirectory() as tmp:
            with patch('run_benchmark.LocalAPI.request',side_effect=TransportError('synthetic offline')), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['--suite','agent','--output-dir',tmp]),2)
            report=json.loads((Path(tmp)/'results.json').read_text())
            self.assertEqual(report['counts'],{'not_run':15})
            self.assertTrue(all(s['pass_rate'] is None for s in report['category_scores'].values()))
            self.assertTrue(report['source_sha256'])
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(main(['--suite','agent','--output-dir',tmp]),2)

    def test_source_changes_invalidate_otherwise_passing_model_run(self):
        from cases import DEFAULT_MODEL
        replies=[{'data':[{'id':DEFAULT_MODEL}]},
                 {'choices':[{'message':{'role':'assistant','content':'{"count":7}'},'finish_reason':'stop'}]}]
        with tempfile.TemporaryDirectory() as tmp:
            with patch('run_benchmark.LocalAPI.request',side_effect=replies), patch('run_benchmark.source_hashes',side_effect=[{'pin':'old'},{'pin':'old'},{'pin':'new'}]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['--suite','agent','--case','A02','--output-dir',tmp]),3)
            report=json.loads((Path(tmp)/'results.json').read_text())
            self.assertEqual(report['status'],'invalidated')
            self.assertFalse(report['source_unchanged'])
            self.assertEqual(len(report['results'][0]['receipt_sha256']),64)

    def test_scores_do_not_hide_unscorable_cases(self):
        scores=category_scores([{'category':'memory','status':s} for s in ['pass','fail','timeout']])['memory']
        self.assertEqual(scores,{'passed':1,'scorable':2,'selected':3,'pass_rate':0.5,'coverage':2/3})
        self.assertIsNone(category_scores([{'category':'memory','status':'not_run'}])['memory']['pass_rate'])
        self.assertIn('grading.py',source_hashes())


if __name__ == '__main__': unittest.main()
