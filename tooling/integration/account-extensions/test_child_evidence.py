#!/usr/bin/env python3
"""Mutate this run's genuine child evidence in memory, never its retained files."""
from pathlib import Path
import copy
import importlib.util
import json
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('account_extension_runner', Path(__file__).with_name('run.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def main(bundle_path):
    out = bundle_path.parent
    bundle = r.parse_json(r.read_file(bundle_path))
    inputs = r.parse_json(r.read_ref(bundle['inputs'], out))
    work = Path(bundle['fixtureHome'])
    r.require([row['name'] for row in bundle['rows']] == list(r.NATIVE), 'Need all genuine native suites')
    originals = {}
    for row in bundle['rows']:
        r.require(row['exitCode'] == 0 and row['failure'] is None, 'Genuine native command did not pass')
        log = r.read_ref(row['log'], out, r.MAX_LOG).decode('utf8')
        r.require(r.canonical(row['result']) == r.canonical(r.parse_result(row['name'], log, {})), 'Native terminal output differs')
        data = r.read_ref(row['childCommands'], out, r.MAX_LOG)
        originals[row['name']] = r.audit_result(data, row['name'], inputs, work)
    cases = []

    def reject(label, mutate, names=None):
        for name in names or list(r.NATIVE):
            rows = copy.deepcopy(originals[name])
            mutate(rows)
            data = b''.join(r.canonical(row) + b'\n' for row in rows)
            try:
                r.audit_result(data, name, inputs, work)
            except ValueError:
                continue
            raise AssertionError(label + ' accepted altered genuine evidence for ' + name)
        cases.append(label)

    def source_args(rows):
        return [i for i, arg in enumerate(rows[0]['argv']) if arg.endswith('.swift')]

    def maps(rows, mutate):
        for key in ['inputsBefore', 'inputsAfter']:
            mutate(rows[0][key])

    def remove_all(rows):
        rows[0]['argv'] = ['/usr/bin/xcrun', 'swiftc', '-o', rows[1]['argv'][0]]
        rows[0]['inputsBefore'] = rows[0]['inputsAfter'] = {}

    def remove_one(rows):
        path = rows[0]['argv'].pop(source_args(rows)[0])
        maps(rows, lambda value: value.pop(path))

    def replace_source(rows):
        i, j = source_args(rows)[:2]
        old = rows[0]['argv'][i]
        rows[0]['argv'][i] = rows[0]['argv'][j]
        maps(rows, lambda value: value.pop(old))

    def swap_sources(rows):
        i, j = source_args(rows)[:2]
        rows[0]['argv'][i], rows[0]['argv'][j] = rows[0]['argv'][j], rows[0]['argv'][i]

    def swap_hashes(rows):
        first, second = list(rows[0]['inputsBefore'])[:2]
        for key in ['inputsBefore', 'inputsAfter']:
            value = rows[0][key]
            value[first]['sha256'], value[second]['sha256'] = value[second]['sha256'], value[first]['sha256']

    reject('removed_all_sources_and_maps', remove_all)
    reject('removed_one_source_and_map', remove_one)
    reject('replaced_source_with_another', replace_source)
    reject('swapped_source_order', swap_sources)
    reject('extra_source_argument', lambda rows: rows[0]['argv'].insert(-2, rows[0]['argv'][source_args(rows)[0]]))
    reject('missing_input_entry', lambda rows: maps(rows, lambda value: value.pop(next(iter(value)))))
    reject('extra_input_entry', lambda rows: maps(rows, lambda value: value.update({'/unreviewed.swift': next(iter(value.values()))})))
    reject('swapped_input_hashes', swap_hashes)
    reject('changed_input_hash', lambda rows: maps(rows, lambda value: next(iter(value.values())).update(sha256='f' * 64)))
    reject('extra_compiler_flag', lambda rows: rows[0]['argv'].insert(2, '-O'))
    reject('changed_compiler_executable', lambda rows: rows[0].update(executable='/usr/bin/true'))
    reject('changed_compiler_identity', lambda rows: rows[0]['executableIdentity'].update(sha256='f' * 64))
    reject('changed_compiler_cwd', lambda rows: rows[0].update(cwd='/tmp'))
    reject('changed_native_executable', lambda rows: rows[1].update(executable='/usr/bin/true'))
    reject('changed_native_cwd', lambda rows: rows[1].update(cwd='/tmp'))
    reject('extra_native_argument', lambda rows: rows[1]['argv'].append('--ignored'))
    reject('changed_binary_identity_path', lambda rows: rows[1]['executableIdentity'].update(path='/tmp/other'))
    reject('changed_binary_identity_hash', lambda rows: rows[1]['executableIdentity'].update(sha256='f' * 64))
    reject('missing_compiler_output', lambda rows: rows[0].update(outputs=[]))
    reject('extra_compiler_output', lambda rows: rows[0]['outputs'].append(copy.deepcopy(rows[0]['outputs'][0])))
    reject('replaced_compiler_output', lambda rows: rows[0]['outputs'][0].update(path='/tmp/other'))
    reject('swapped_compiler_output', lambda rows: rows[0].update(outputs=copy.deepcopy(originals['github-accounts' if rows[0]['outputs'][0] != originals['github-accounts'][0]['outputs'][0] else 'gmail-accounts'][0]['outputs'])))
    reject('extra_native_output', lambda rows: rows[1].update(outputs=copy.deepcopy(rows[0]['outputs'])))
    reject('missing_child_row', lambda rows: rows.pop())
    reject('duplicate_child_row', lambda rows: rows.append(copy.deepcopy(rows[-1])))
    reject('nonzero_child_exit', lambda rows: rows[1].update(exitCode=1))
    dispatch = ['private-account-dispatch']
    reject('changed_generated_dispatch_bytes', lambda rows: maps(rows, lambda value: next(ref for path, ref in value.items() if path.endswith('/fixtures.swift')).update(sha256='f' * 64)), dispatch)
    # These Drive-specific mutations supplement every generic mutation above,
    # which now also executes against the genuine Drive compiler/runner rows.
    def remove_drive_source(rows, relative):
        path = str(r.ROOT / relative)
        rows[0]['argv'].remove(path)
        maps(rows, lambda value: value.pop(path))

    reject('removed_drive_oauth_source_and_map', lambda rows: remove_drive_source(rows, 'source/DriveOAuth.swift'), ['drive-accounts', 'private-account-dispatch'])
    reject('removed_drive_account_source_and_map', lambda rows: remove_drive_source(rows, 'source/DriveAccount.swift'), ['drive-accounts', 'private-account-dispatch'])
    reject('removed_drive_fixture_source_and_map', lambda rows: remove_drive_source(rows, 'tooling/drive_accounts_check.swift'), ['drive-accounts'])

    def remove_drive_fragment(rows):
        data = b'\n'.join(r.bound_source_bytes(relative, inputs).split(anchor)[0] for relative, anchor in [
            ('tooling/github_accounts_check.swift', b'@main struct GitHubAccountsCheck'),
            ('tooling/gmail_accounts_check.swift', b'@main struct GmailAccountsCheck')])
        maps(rows, lambda value: next(ref for path, ref in value.items() if path.endswith('/fixtures.swift')).update(bytes=len(data), sha256=r.digest(data)))

    reject('removed_drive_dispatch_fragment', remove_drive_fragment, dispatch)

    def replace_drive_execution(rows):
        for key in ['argv', 'executable', 'executableIdentity']:
            rows[1][key] = copy.deepcopy(originals['gmail-accounts'][1][key])

    reject('replaced_drive_execution_with_gmail_binary', replace_drive_execution, ['drive-accounts'])
    launch = ['external-launch-native']
    for index, label in [(0, 'node'), (1, 'mode'), (2, 'eval_flag'), (3, 'script'), (4, 'module_url'), (5, 'directory')]:
        reject('changed_parity_' + label, lambda rows, index=index: rows[2]['argv'].__setitem__(index, 'changed'), launch)
    for index, label in [(0, 'binary'), (1, 'flag'), (2, 'review'), (3, 'contract'), (4, 'directory'), (5, 'revision')]:
        reject('changed_native_parity_' + label, lambda rows, index=index: rows[3]['argv'].__setitem__(index, 'changed'), launch)
    reject('missing_parity_output', lambda rows: rows[2].update(outputs=[]), launch)
    reject('extra_parity_output', lambda rows: rows[2]['outputs'].append(copy.deepcopy(rows[2]['outputs'][0])), launch)
    reject('changed_parity_output_hash', lambda rows: rows[2]['outputs'][0].update(sha256='f' * 64), launch)
    reject('missing_parity_input_maps', lambda rows: rows[3].update(inputsBefore={}, inputsAfter={}), launch)
    reject('changed_parity_input_hash', lambda rows: rows[3]['inputsBefore'][rows[3]['argv'][2]].update(sha256='f' * 64), launch)
    reject('extra_parity_native_output', lambda rows: rows[3].update(outputs=copy.deepcopy(rows[2]['outputs'])), launch)
    print(json.dumps({'passed': True, 'testCases': len(cases), 'caseNames': cases}))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Expected this run\'s NATIVE-EVIDENCE.json')
    main(Path(sys.argv[1]).absolute())
