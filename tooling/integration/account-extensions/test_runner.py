#!/usr/bin/env python3
"""Adversarial pure parser/preflight/evidence tests; disposable files/processes only."""
from pathlib import Path
import contextlib
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('account_extension_runner', Path(__file__).with_name('run.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def tap():
    lines = ['TAP version 13']
    for i, name in enumerate(r.TOOL_CASES, 1):
        lines.extend(['# Subtest: ' + name, f'ok {i} - {name}', '  ---', '  duration_ms: 1.0', "  type: 'test'", '  ...'])
    lines.extend(['1..7', '# tests 7', '# suites 0', '# pass 7', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 1.0'])
    return '\n'.join(lines) + '\n'


def native(name):
    lines = [r.NATIVE[name][2]]
    if name == 'external-launch-native':
        lines.append(r.PARITY)
    if name in r.STATIC:
        lines.append(json.dumps(r.STATIC[name]))
    return '\n'.join(lines) + '\n'


class Cases(unittest.TestCase):
    def reject(self, function, *args):
        with self.assertRaises((ValueError, FileNotFoundError, UnicodeDecodeError, OSError)):
            function(*args)

    def test_native_complete_assertions_are_not_cases(self):
        for name, (_, count, _) in r.NATIVE.items():
            value = r.parse_result(name, native(name), {})
            self.assertEqual(value['assertions'], count)
            self.assertNotIn('testCases', value)

    def test_native_missing_marker(self):
        for name in r.NATIVE:
            self.reject(r.parse_result, name, '\n', {})

    def test_native_wrong_or_zero_assertions(self):
        for name, (_, count, _) in r.NATIVE.items():
            self.reject(r.parse_result, name, native(name).replace(str(count), '0', 1), {})

    def test_native_duplicate_marker(self):
        for name in r.NATIVE:
            self.reject(r.parse_result, name, native(name) + native(name), {})

    def test_native_nonfinal_marker(self):
        for name in r.NATIVE:
            self.reject(r.parse_result, name, native(name) + 'ignored failure\n', {})

    def test_native_skipped_or_todo(self):
        for name in r.NATIVE:
            for extra in ['# SKIP', '# TODO', 'cancelled', 'not ok']:
                self.reject(r.parse_result, name, native(name) + extra + '\n', {})

    def test_native_missing_real_parity(self):
        value = native('external-launch-native').replace(r.PARITY + '\n', '')
        self.reject(r.parse_result, 'external-launch-native', value, {})

    def test_native_partial_routing_receipt(self):
        value = r.NATIVE['external-install-native'][2] + '\n{"nativeMandatoryApprovalRouting":true}\n'
        self.reject(r.parse_result, 'external-install-native', value, {})

    def test_native_duplicate_json_keys(self):
        value = native('external-install-native').replace('"stopOwnership": true', '"stopOwnership": false, "stopOwnership": true')
        self.reject(r.parse_result, 'external-install-native', value, {})

    def test_native_false_and_numeric_true_rejected(self):
        value = native('external-install-native')
        self.reject(r.parse_result, 'external-install-native', value.replace('true', 'false', 1), {})
        self.reject(r.parse_result, 'external-install-native', value.replace('true', '1', 1), {})

    def test_js_complete_and_honest_units(self):
        for name, (_, marker) in r.JS.items():
            value = r.parse_result(name, marker + '\n', {})
            self.assertEqual(value.get('durableClaimFamilies', value.get('completedSuites')), 6 if name == 'external-claims' else 1)
            self.assertNotIn('assertions', value)

    def test_js_missing_duplicate_nonfinal_and_unterminated(self):
        for name, (_, marker) in r.JS.items():
            for value in ['', marker, marker + '\n' + marker + '\n', marker + '\n# skipped 1\n']:
                self.reject(r.parse_result, name, value, {})

    def test_tap_complete_named_cases(self):
        self.assertEqual(r.tap_result(tap()), {'testCases': 7, 'caseNames': r.TOOL_CASES})

    def test_tap_missing_summary(self):
        for key in ['tests 7', 'pass 7', 'fail 0', 'cancelled 0', 'skipped 0', 'todo 0']:
            self.reject(r.tap_result, tap().replace('# ' + key + '\n', ''))

    def test_tap_duplicate_summary(self):
        self.reject(r.tap_result, tap().replace('# pass 7', '# pass 7\n# pass 7'))

    def test_tap_partial_or_duplicate_case(self):
        self.reject(r.tap_result, tap().replace('ok 7 - ' + r.TOOL_CASES[6] + '\n', ''))
        self.reject(r.tap_result, tap().replace('ok 7 - ', 'ok 1 - '))

    def test_tap_zero_tests(self):
        self.reject(r.tap_result, tap().replace('# tests 7', '# tests 0').replace('# pass 7', '# pass 0').replace('1..7', '1..0'))

    def test_tap_skip_todo_cancel_fail(self):
        for key in ['skipped', 'todo', 'cancelled', 'fail']:
            self.reject(r.tap_result, tap().replace('# ' + key + ' 0', '# ' + key + ' 1'))
        for suffix in ['# SKIP', '# TODO']:
            self.reject(r.tap_result, tap().replace('ok 1 - ' + r.TOOL_CASES[0], 'ok 1 - ' + r.TOOL_CASES[0] + ' ' + suffix))
        self.reject(r.tap_result, tap().replace('ok 1 - ', 'not ok 1 - '))

    def test_tap_nonfinal_plan_and_unknown_output(self):
        self.reject(r.tap_result, tap() + 'late output\n')
        self.reject(r.tap_result, tap().replace('TAP version 13\n', 'TAP version 13\nunknown\n'))
        self.reject(r.tap_result, tap().replace('1..7\n', '1..7\n1..7\n'))
        self.reject(r.tap_result, tap().replace('1..7\n', '1..8\n1..7\n'))
        self.reject(r.tap_result, tap().replace('# duration_ms 1.0', '# duration_ms 1.0\n# duration_ms 1.0'))

    def test_selftests_missing_duplicate_and_zero(self):
        contract = {'selfTestCases': ['a', 'b']}
        value = {'passed': True, 'caseNames': ['a', 'b'], 'testCases': 2}
        self.assertEqual(r.parse_result('runner-adversarial-tests', json.dumps(value) + '\n', contract), value)
        for change in [{'caseNames': ['a', 'a']}, {'testCases': 0}, {'passed': False}, {'caseNames': ['a']}, {'passed': 1}]:
            self.reject(r.parse_result, 'runner-adversarial-tests', json.dumps({**value, **change}) + '\n', contract)

    def test_duplicate_nonfinite_json(self):
        for value in ['{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}']:
            self.reject(r.parse_json, value)

    def test_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.reject(r.read_file, Path(tmp).resolve() / 'missing')

    def test_symlink_file_and_ancestor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'file').write_text('ok')
            (root / 'link').symlink_to(root / 'file')
            (root / 'dir').mkdir()
            (root / 'dir/inner').write_text('ok')
            (root / 'linked-dir').symlink_to(root / 'dir')
            self.reject(r.read_file, root / 'link')
            self.reject(r.read_file, root / 'linked-dir/inner')

    def test_hardlink_and_oversize_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'file').write_text('1234')
            self.reject(r.read_file, root / 'file', 3)
            os.link(root / 'file', root / 'hard')
            self.reject(r.read_file, root / 'file')

    def test_tampered_missing_and_external_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            value = r.save_new(root / 'evidence.json', {'ok': True})
            self.assertTrue(r.read_ref(value, root))
            (root / 'evidence.json').write_text('tampered')
            self.reject(r.read_ref, value, root)
            self.reject(r.read_ref, value, root / 'wrong')
            (root / 'evidence.json').unlink()
            self.reject(r.read_ref, value, root)

    def test_missing_or_tampered_fixture_pin(self):
        value = {'fixture': {'sha256': 'a' * 64}}
        r.check_pins(value, {'fixture': 'a' * 64})
        self.reject(r.check_pins, value, {'fixture': 'b' * 64})
        self.reject(r.check_pins, {}, {'fixture': 'a' * 64})
        self.reject(r.check_pins, value, {})

    @contextlib.contextmanager
    def repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            for name in ['source', 'tests', 'tooling']:
                (root / name).mkdir()
                (root / name / 'fixture').write_text('reviewed')
            (root / '.gitignore').write_text('*.ignored\n')
            def git(*argv):
                subprocess.run(['/usr/bin/git', '-C', str(root), *argv], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            git('init')
            git('add', '.')
            git('-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture')
            yield root

    def test_clean_checkout_snapshot(self):
        with self.repo() as root:
            self.assertEqual(r.git_state(root)['status'], '')
            self.assertEqual(len(r.source_snapshot(root)), 4)

    def test_dirty_checkout_refused(self):
        with self.repo() as root:
            (root / 'source/fixture').write_text('changed')
            self.reject(r.git_state, root)

    def test_missing_source_refused(self):
        with self.repo() as root:
            (root / 'source/fixture').unlink()
            self.reject(r.source_snapshot, root)

    def test_ignored_source_injection_refused(self):
        with self.repo() as root:
            (root / 'source/extra.ignored').write_text('injected')
            self.assertEqual(r.git_state(root)['status'], '')
            self.reject(r.source_snapshot, root)

    def test_source_symlink_refused(self):
        with self.repo() as root:
            (root / 'source/fixture').unlink()
            (root / 'source/fixture').symlink_to(root / 'tests/fixture')
            self.reject(r.source_snapshot, root)

    def test_dependency_snapshot_missing_and_escape_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            self.reject(r.dependency_snapshot, root / 'missing')
            deps = root / 'dependencies'
            deps.mkdir()
            self.reject(r.dependency_snapshot, deps)
            (root / 'outside').write_text('not a dependency')
            (deps / 'escape').symlink_to('../outside')
            self.reject(r.dependency_snapshot, deps)

    def test_dependency_snapshot_tamper_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / 'file').write_text('reviewed')
            before = r.digest(r.canonical(r.dependency_snapshot(root)))
            (root / 'file').write_text('changed')
            self.assertNotEqual(before, r.digest(r.canonical(r.dependency_snapshot(root))))

    def test_child_commands_partial_duplicate_or_no_compile(self):
        with self.complete_receipt() as (value, path, save, before):
            row = next(item for item in value['rows'] if item['name'] == 'github-accounts')
            original = [json.loads(line) for line in Path(row['childCommands']['path']).read_text().splitlines()]
            encode = lambda rows: ('\n'.join(json.dumps(row) for row in rows) + '\n').encode()
            for rows in [original[:1], [original[0], original[0]], original + [original[1]]]:
                self.reject(r.audit_result, encode(rows), 'github-accounts', before, Path(value['fixtureHome']))
            changed = copy.deepcopy(original)
            changed[0]['argv'] = ['/usr/bin/xcrun', 'swiftc', '-o', original[1]['argv'][0]]
            changed[0]['inputsBefore'] = changed[0]['inputsAfter'] = {}
            self.reject(r.audit_result, encode(changed), 'github-accounts', before, Path(value['fixtureHome']))

    def test_drive_fixture_pins_missing_or_tampered(self):
        contract = r.parse_json(r.read_file(r.HERE / 'CONTRACT.json'))
        for name in ['tooling/check_drive_accounts.py', 'tooling/drive_accounts_check.swift',
                     'tooling/check_private_account_dispatch.py', 'tooling/private_account_dispatch_check.swift']:
            self.assertIn(name, contract['fixtures'])
            actual = {name: {'sha256': r.digest(r.read_file(r.ROOT / name))}}
            pins = {name: contract['fixtures'][name]}
            r.check_pins(actual, pins)
            self.reject(r.check_pins, {}, pins)
            actual[name]['sha256'] = 'f' * 64
            self.reject(r.check_pins, actual, pins)

    def test_drive_compile_inputs_and_execution_are_mandatory(self):
        with self.complete_receipt() as (value, path, save, before):
            row = next(item for item in value['rows'] if item['name'] == 'drive-accounts')
            original = [json.loads(line) for line in Path(row['childCommands']['path']).read_text().splitlines()]
            def rejected(rows):
                data = b''.join(r.canonical(item) + b'\n' for item in rows)
                self.reject(r.audit_result, data, 'drive-accounts', before, Path(value['fixtureHome']))
            for relative in r.NATIVE_COMPILE['drive-accounts'][2]:
                target = str(r.ROOT / relative)
                changed = copy.deepcopy(original)
                changed[0]['argv'].remove(target)
                for key in ['inputsBefore', 'inputsAfter']:
                    changed[0][key].pop(target)
                rejected(changed)
                changed = copy.deepcopy(original)
                for key in ['inputsBefore', 'inputsAfter']:
                    changed[0][key][target]['sha256'] = 'f' * 64
                rejected(changed)
            rejected(original[:1])
            changed = copy.deepcopy(original)
            changed[1]['argv'] = ['/usr/bin/true']
            changed[1]['executable'] = '/usr/bin/true'
            rejected(changed)
            rejected(original + [copy.deepcopy(original[-1])])

    def test_receipt_drive_row_missing_duplicate_or_replaced(self):
        for mutation in ['missing', 'duplicate', 'replaced']:
            with self.complete_receipt() as (value, path, save, before):
                index = next(i for i, row in enumerate(value['rows']) if row['name'] == 'drive-accounts')
                if mutation == 'missing':
                    value['rows'].pop(index)
                elif mutation == 'duplicate':
                    value['rows'].insert(index, copy.deepcopy(value['rows'][index]))
                else:
                    value['rows'][index] = copy.deepcopy(next(row for row in value['rows'] if row['name'] == 'gmail-accounts'))
                self.reject(r.verify, path, save(), before['git']['commit'])

    def test_dispatch_requires_drive_generated_fixture(self):
        with self.complete_receipt() as (value, path, save, before):
            row = next(item for item in value['rows'] if item['name'] == 'private-account-dispatch')
            changed = [json.loads(line) for line in Path(row['childCommands']['path']).read_text().splitlines()]
            old = b'\n'.join(r.bound_source_bytes(relative, before).split(anchor)[0] for relative, anchor in [
                ('tooling/github_accounts_check.swift', b'@main struct GitHubAccountsCheck'),
                ('tooling/gmail_accounts_check.swift', b'@main struct GmailAccountsCheck')])
            self.assertNotEqual(r.digest(old), r.digest(r.dispatch_fixture_bytes(before)))
            for key in ['inputsBefore', 'inputsAfter']:
                generated = next(item for path, item in changed[0][key].items() if path.endswith('/fixtures.swift'))
                generated.update(bytes=len(old), sha256=r.digest(old))
            data = b''.join(r.canonical(item) + b'\n' for item in changed)
            self.reject(r.audit_result, data, 'private-account-dispatch', before, Path(value['fixtureHome']))

    def test_old_aggregate_stop_completion_rejected(self):
        old = 'PASS: 17 aggregate account Stop assertions, including actual injected GitHub/Gmail sessions and no subsequent refresh. No network, browser, UI, listener or Keychain.\n'
        self.reject(r.parse_result, 'private-account-dispatch', old, {})
        self.assertEqual(r.parse_result('private-account-dispatch', native('private-account-dispatch'), {})['assertions'], 21)
        self.assertEqual(r.parse_result('drive-accounts', native('drive-accounts'), {})['assertions'], 208)

    def test_runner_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            result = r.run_bounded([sys.executable, '-c', 'print("not a success");raise SystemExit(7)'], root, {'PATH': '/usr/bin:/bin'}, root / 'out.log')
            self.assertEqual(result['exitCode'], 7)

    def test_runner_log_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            result = r.run_bounded([sys.executable, '-c', 'print("x"*8192)'], root, {'PATH': '/usr/bin:/bin'}, root / 'out.log', max_log=512)
            self.assertEqual(result['failure'], 'log-bound')
            self.assertLessEqual((root / 'out.log').stat().st_size, 512)

    def test_runner_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            result = r.run_bounded([sys.executable, '-c', 'import time;time.sleep(5)'], root, {'PATH': '/usr/bin:/bin'}, root / 'out.log', timeout=.05)
            self.assertEqual(result['failure'], 'timeout')
            self.assertNotEqual(result['exitCode'], 0)

    def test_receipt_digest_and_partial_receipt_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            receipt = r.save_new(root / 'RESULT.json', {'complete': False})
            self.reject(r.verify, root / 'RESULT.json', 'a' * 64, 'b' * 40)
            self.reject(r.verify, root / 'RESULT.json', receipt['sha256'], 'b' * 40)


    @contextlib.contextmanager
    def complete_receipt(self):
        # Synthetic verifier input, never qualification evidence. Actual preflight is replaced
        # only inside these unit tests so source/runtime matching can be fault-injected.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            digest = 'a' * 64
            ident = lambda path: {'path': str(path), 'sha256': digest, 'bytes': 1}
            tools = {'python': ident(sys.executable), 'node': ident('/pinned/node'), 'xcrun': ident('/usr/bin/xcrun')}
            source_names = {name for _, _, names in r.NATIVE_COMPILE.values() for name in names if not name.startswith('@')}
            source_names.update([item[0] for item in r.NATIVE.values()])
            source_names.update(['tooling/github_accounts_check.swift', 'tooling/gmail_accounts_check.swift', 'source/runtime-contract.json'])
            source = {}
            for name in source_names:
                data = r.read_file(r.ROOT / name)
                source[name] = {'sha256': r.digest(data), 'bytes': len(data)}
            before = {'git': {'commit': 'b' * 40, 'status': ''}, 'source': source, 'tools': tools}
            work = root / 'noiee-account-extensions-synthetic'
            contract = r.parse_json(r.read_file(r.HERE / 'CONTRACT.json'))
            rows = []
            for name in r.ORDER:
                if name in r.NATIVE:
                    text = native(name)
                elif name in r.JS:
                    text = r.JS[name][1] + '\n'
                elif name == 'tool-actions':
                    text = tap()
                elif name == 'agent-syntax':
                    text = ''
                elif name == 'native-evidence-mutations':
                    text = json.dumps({'passed': True, 'caseNames': contract['nativeEvidenceTestCases'], 'testCases': len(contract['nativeEvidenceTestCases'])}) + '\n'
                else:
                    text = json.dumps({'passed': True, 'caseNames': contract['selfTestCases'], 'testCases': len(contract['selfTestCases'])}) + '\n'
                log = root / (name + '.log')
                log.write_text(text)
                row = {'name': name, 'command': r.commands(name, tools, root), 'cwd': str(r.ROOT), 'exitCode': 0, 'failure': None,
                       'log': r.ref(log), 'result': {'syntaxOnly': True} if name == 'agent-syntax' else r.parse_result(name, text, contract)}
                if name in r.NATIVE:
                    binary = str(work / 'tmp' / (r.NATIVE_COMPILE[name][0] + 'abcdefgh') / 'check')
                    compiler_argv, compiler_inputs = r.native_compile_contract(name, before, work, binary)
                    base = {'sequence': 1, 'executable': '/usr/bin/xcrun', 'argv': compiler_argv,
                            'cwd': str(r.ROOT), 'executableIdentity': tools['xcrun'], 'inputsBefore': compiler_inputs,
                            'inputsAfter': compiler_inputs, 'outputs': [ident(binary)], 'exitCode': 0}
                    child = [base, {**base, 'sequence': 2, 'executable': binary, 'executableIdentity': ident(binary),
                                   'argv': [binary], 'inputsBefore': {}, 'inputsAfter': {}, 'outputs': []}]
                    if name == 'external-launch-native':
                        parent = work / 'home/Library/Caches/noiee-review-parity-abcdefgh'
                        review = str(parent / 'review.json')
                        runtime = r.source_identity('source/runtime-contract.json', before)
                        review_inputs = {review: ident(review), runtime['path']: runtime}
                        child.extend([{**base, 'sequence': 3, 'executable': str(r.PINNED_NODE), 'executableIdentity': tools['node'],
                                       'inputsBefore': {}, 'inputsAfter': {}, 'outputs': [ident(review)],
                                       'argv': [str(r.PINNED_NODE), '--input-type=module', '-e', r.parity_script(before),
                                                (r.ROOT / 'source/external-tool-runtime.mjs').as_uri(), str(parent)]},
                                      {**child[1], 'sequence': 4, 'inputsBefore': review_inputs, 'inputsAfter': review_inputs,
                                       'argv': [binary, '--validate-review', review, runtime['path'], str(parent), r.digest(r.PARITY_ARTIFACT)]}])
                    path = root / (name + '.commands.jsonl')
                    path.write_text(''.join(json.dumps(row) + '\n' for row in child))
                    row['childCommands'] = r.ref(path)
                rows.append(row)
            work = root / 'noiee-account-extensions-synthetic'
            value = {'schemaVersion': 1, 'kind': 'noiee-offline-account-extensions', 'status': 'passed', 'complete': True,
                     'releaseEligible': False, 'scope': r.SCOPE, 'fixtureHome': str(work), 'environment': r.fixture_environment(work),
                     'inputsBefore': r.save_new(root / 'before.json', before), 'inputsAfter': r.save_new(root / 'after.json', before),
                     'rows': rows, 'totals': r.totals(rows)}
            value['nativeEvidence'] = r.save_new(root / 'NATIVE-EVIDENCE.json',
                {'inputs': value['inputsBefore'], 'fixtureHome': str(work), 'rows': [row for row in rows if row['name'] in r.NATIVE]})
            path = root / 'RESULT.json'
            def save():
                path.write_bytes(r.canonical(value) + b'\n')
                return r.ref(path)['sha256']
            with patch.object(r, 'preflight', return_value=before):
                r.verify(path, save(), 'b' * 40)
                yield value, path, save, before

    def test_complete_receipt_verifies(self):
        with self.complete_receipt() as (value, path, save, before):
            self.assertEqual(r.verify(path, save(), before['git']['commit']), value)

    def test_receipt_partial_duplicate_or_reordered_suite(self):
        for mutation in ['missing', 'duplicate', 'reordered']:
            with self.complete_receipt() as (value, path, save, before):
                if mutation == 'missing':
                    value['rows'].pop()
                elif mutation == 'duplicate':
                    value['rows'].append(value['rows'][-1])
                else:
                    value['rows'][0], value['rows'][1] = value['rows'][1], value['rows'][0]
                self.reject(r.verify, path, save(), before['git']['commit'])

    def test_receipt_nonzero_timeout_or_overflow(self):
        for change in [{'exitCode': 1}, {'exitCode': True}, {'failure': 'timeout'}, {'failure': 'log-bound'}]:
            with self.complete_receipt() as (value, path, save, before):
                value['rows'][1].update(change)
                self.reject(r.verify, path, save(), before['git']['commit'])

    def test_receipt_wrong_commit_or_changed_inputs(self):
        with self.complete_receipt() as (value, path, save, before):
            self.reject(r.verify, path, save(), 'c' * 40)
            changed = copy.deepcopy(before)
            changed['git']['commit'] = 'd' * 40
            with patch.object(r, 'preflight', return_value=changed):
                self.reject(r.verify, path, save(), before['git']['commit'])
            changed['git']['commit'] = before['git']['commit']
            changed['tools']['node']['sha256'] = 'e' * 64
            with patch.object(r, 'preflight', return_value=changed):
                self.reject(r.verify, path, save(), before['git']['commit'])

    def test_receipt_tampered_log_even_after_rehash(self):
        with self.complete_receipt() as (value, path, save, before):
            row = value['rows'][1]
            log = Path(row['log']['path'])
            log.write_text(log.read_text() + 'late output\n')
            self.reject(r.verify, path, save(), before['git']['commit'])
            row['log'] = r.ref(log)
            self.reject(r.verify, path, save(), before['git']['commit'])

    def test_receipt_missing_or_symlink_log(self):
        for linked in [False, True]:
            with self.complete_receipt() as (value, path, save, before):
                log = Path(value['rows'][1]['log']['path'])
                text = log.read_text()
                log.unlink()
                if linked:
                    target = log.with_suffix('.other')
                    target.write_text(text)
                    log.symlink_to(target)
                self.reject(r.verify, path, save(), before['git']['commit'])

    def test_receipt_altered_command_or_ambient_environment(self):
        with self.complete_receipt() as (value, path, save, before):
            value['rows'][1]['command'][2] = '(version 1)(allow default)'
            self.reject(r.verify, path, save(), before['git']['commit'])
        with self.complete_receipt() as (value, path, save, before):
            value['environment']['NODE_OPTIONS'] = '--import=unreviewed'
            self.reject(r.verify, path, save(), before['git']['commit'])

    def test_receipt_invented_counts_and_release_eligibility(self):
        for key in ['nativeAssertions', 'toolActionTestCases', 'durableClaimFamilies']:
            with self.complete_receipt() as (value, path, save, before):
                value['totals'][key] += 1
                self.reject(r.verify, path, save(), before['git']['commit'])
        with self.complete_receipt() as (value, path, save, before):
            value['releaseEligible'] = True
            self.reject(r.verify, path, save(), before['git']['commit'])

    def test_receipt_failed_verification_cannot_be_reused(self):
        with self.complete_receipt() as (value, path, save, before):
            (path.parent / 'VERIFICATION_FAILED.json').write_text('{}')
            self.reject(r.verify, path, save(), before['git']['commit'])


if __name__ == '__main__':
    names = unittest.defaultTestLoader.getTestCaseNames(Cases)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream).run(unittest.defaultTestLoader.loadTestsFromTestCase(Cases))
    if not result.wasSuccessful() or result.testsRun != len(names) or result.skipped or result.expectedFailures or result.unexpectedSuccesses:
        print(stream.getvalue(), file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps({'passed': True, 'caseNames': names, 'testCases': result.testsRun}))
