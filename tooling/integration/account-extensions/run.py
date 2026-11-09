#!/usr/bin/env python3
"""Source-bound offline account/extension gates. Never a release or app runner."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PROFILE = '(version 1)(allow default)(deny network*)'
MAX_LOG = 1024 * 1024
MAX_JSON = 8 * MAX_LOG
PINNED_NODE = Path('/opt/homebrew/bin/node')
DEPENDENCIES = Path('/Users/saleh/Documents/Noiee/dependencies/node-26.13.0-build171')
NATIVE = {
    'private-account-dispatch': ('tooling/check_private_account_dispatch.py', 17, 'PASS: 17 aggregate account Stop assertions, including actual injected GitHub/Gmail sessions and no subsequent refresh. No network, browser, UI, listener or Keychain.'),
    'private-accounts': ('tooling/check_private_accounts.py', 197, 'PASS: 197 offline connector assertions. No Keychain access, browser, accounts, network, app UI or model used.'),
    'github-accounts': ('tooling/check_github_accounts.py', 256, 'PASS: 256 offline GitHub device/identity/consent/refresh/read/disconnect assertions. No browser, network, Keychain, app UI or real account used.'),
    'gmail-accounts': ('tooling/check_gmail_accounts.py', 187, 'PASS: 187 offline Gmail OAuth/identity/consent/read/refresh/revoke assertions. Public RSA vector verified; all session transports, listener, stores and consent injected. No live provider, socket, browser, UI or Keychain.'),
    'external-install-native': ('tooling/tests/test_external_tool_install.py', 60, 'PASS: 60 external artifact native fixture assertions. No external code executed.'),
    'external-launch-native': ('tooling/tests/test_external_tool_launch.py', 76, 'PASS: 76 external launch native fixture assertions. No provider or external code executed.'),
}
PARITY = 'PASS: production Node review canonical digest/config/runtime accepted by native validator without launch'
STATIC = {
    'external-install-native': {'nativeMandatoryApprovalRouting': True, 'stopOwnership': True, 'noExternalRuntimeExecuted': True},
    'external-launch-native': {'nativeMandatoryLaunchReview': True, 'fixedLoaderParity': True, 'ownedStopAndDrain': True},
}
JS = {
    'private-account-status': ('tests/private-account-status-check.mjs', 'PASS: Gmail/GitHub read-only schema, native-only account controls, local destination, Stop wiring and no Full Access consent bypass. Static integration test only.'),
    'private-account-destination': ('tests/private-account-destination-check.mjs', 'PASS: local model destination validation, immutable origin, no cloud fallback/redirect, durable Gmail destination and separate Coding exposure. No network.'),
    'external-download': ('source/external-artifact-download-check.mjs', 'PASS strict external-artifact parser, DNS pinning, peer/TLS checks, bounded inert stream, timeout/abort, hash and response validation (offline only)'),
    'external-route': ('source/external-artifact-route-check.mjs', 'PASS: inert external artifact signed routes, replay/forgery, clean/recovery boot, Stop and exact Agent binding. No sockets, network or external execution.'),
    'external-claims': ('source/external-tool-claims-check.mjs', 'PASS: six real durable Agent claim families reject forged/mutated/replayed effects and model-made launch commits. No model/network/provider execution.'),
    'external-runtime': ('source/external-tool-runtime-check.mjs', 'PASS external runtime offline review, replay, boot, stop, uncertain, collision and grant checks; fd3 snapshot/hash/bounds and clean-environment checks; no unknown artifact execution.'),
}
TOOL_CASES = [
    'skill actions have separate grouped controls and preserve install/read dispatch',
    'missing skill scope disables both actions without removing their labels',
    'Fetch install and enable remain separate through installed, enabled and disabled states',
    'unavailable Fetch preserves disabled controls; held connections offer explicit Enable',
    'repeated activation stays fenced; errors and Stop clear stale grouped actions',
    'single connection action retains its existing direct-child layout',
    'only single direct actions receive grid placement; grouped actions wrap in flex flow',
]
ORDER = ['runner-adversarial-tests', *NATIVE, 'native-evidence-mutations', *JS, 'tool-actions', 'agent-syntax']
SCOPE = {
    'network': 'All suite processes and descendants run under macOS sandbox-exec deny network*. Auth uses injected HTTP/listener/store/consent fixtures; no production sockets, providers or Keychain.',
    'execution': 'Runtime suite executes only locally authored synthetic loader/stdio fixture processes. Installed artifact bytes remain inert; no unknown/downloaded code runs.',
    'excluded': ['Drive implementation/selection', 'live accounts and OAuth grants', 'real Keychain', 'native UI', 'installed app', 'user stores', 'models', 'real download', 'unknown external execution', 'full native app compilation', 'release adapters', 'signing', 'installation'],
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def parse_json(data):
    return json.loads(data, object_pairs_hook=no_duplicates,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON: ' + value)))


def safe_path(path):
    path = Path(path).absolute()
    require(path == Path(os.path.normpath(path)), 'Noncanonical path')
    for ancestor in reversed([path, *path.parents]):
        require(not ancestor.is_symlink(), 'Symlink input: ' + str(ancestor))
    return path


def read_file(path, limit=MAX_JSON):
    path = safe_path(path)
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'Expected single-link regular file: ' + str(path))
    require(before.st_size <= limit, 'File exceeds bound: ' + str(path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        data = stream.read(limit + 1)
        after_fd = os.fstat(stream.fileno())
    after = path.lstat()
    keys = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    require(all(getattr(before, key) == getattr(value, key) for value in [opened, after_fd, after] for key in keys)
            and len(data) == before.st_size, 'Input changed during read: ' + str(path))
    return data


def ref(path, limit=MAX_JSON):
    data = read_file(path, limit)
    return {'path': str(Path(path).absolute()), 'sha256': digest(data), 'bytes': len(data)}


def read_ref(value, parent, limit=MAX_JSON):
    require(type(value) is dict and set(value) == {'path', 'sha256', 'bytes'}
            and type(value['path']) is str and type(value['bytes']) is int and value['bytes'] >= 0
            and type(value['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', value['sha256']), 'Malformed file reference')
    path = Path(value['path'])
    require(path.parent == parent and path.is_absolute(), 'Evidence outside receipt directory')
    data = read_file(path, limit)
    require(value == {'path': str(path), 'sha256': digest(data), 'bytes': len(data)}, 'Evidence hash/size mismatch')
    return data


def save_new(path, value):
    data = canonical(value) + b'\n'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return ref(path)


def output(command):
    return subprocess.check_output(command, cwd=ROOT, timeout=30,
                                   env={'PATH': '/usr/bin:/bin', 'GIT_OPTIONAL_LOCKS': '0'}, text=True).strip()


def git_state(root=ROOT):
    prefix = ['/usr/bin/git', '-C', str(root)]
    require(output(prefix + ['rev-parse', '--show-toplevel']) == str(root), 'Expected checkout root')
    state = {'commit': output(prefix + ['rev-parse', 'HEAD']),
             'status': output(prefix + ['status', '--porcelain=v1', '--untracked-files=all'])}
    require(state['status'] == '', 'Commit all source and runner inputs before qualification')
    return state


def source_snapshot(root=ROOT):
    names = output(['/usr/bin/git', '-C', str(root), 'ls-files', '-z']).removesuffix('\0').split('\0')
    require(names and len(names) == len(set(names)) and all(names), 'Empty or duplicate source list')
    rows = {}
    for name in sorted(names):
        require(not Path(name).is_absolute() and '..' not in Path(name).parts, 'Unsafe source path')
        path = root / name
        data = read_file(path, 128 * MAX_LOG)
        rows[name] = {'sha256': digest(data), 'bytes': len(data), 'mode': stat.S_IMODE(path.lstat().st_mode)}
    # Git ignores dependencies/artifacts, but no ignored injection may join executable input namespaces.
    actual = set()
    for namespace in ['source', 'tests', 'tooling']:
        for parent, dirs, files in os.walk(root / namespace, followlinks=False):
            for name in list(dirs):
                path = Path(parent) / name
                if path == root / 'source/node_modules':
                    dirs.remove(name)
                else:
                    safe_path(path)
            for name in files:
                path = Path(parent) / name
                if path != root / 'source/node_modules':
                    actual.add(path.relative_to(root).as_posix())
    expected = {name for name in names if name.split('/')[0] in {'source', 'tests', 'tooling'}}
    require(actual == expected, 'Unexpected or missing source/fixture namespace entries')
    return rows


def dependency_snapshot(path=DEPENDENCIES):
    safe_path(path)
    require(path.is_dir(), 'Missing pinned dependency snapshot')
    rows = {}
    for item in sorted(path.rglob('*')):
        st = item.lstat()
        key = item.relative_to(path).as_posix()
        if stat.S_ISLNK(st.st_mode):
            target = os.readlink(item)
            require(not Path(target).is_absolute() and item.resolve(strict=True).is_relative_to(path), 'Dependency link escapes snapshot')
            require(item.resolve(strict=True).is_file(), 'Dependency directory symlink refused')
            rows[key] = {'type': 'symlink', 'target': target}
        elif stat.S_ISDIR(st.st_mode):
            rows[key] = {'type': 'directory', 'mode': stat.S_IMODE(st.st_mode)}
        else:
            data = read_file(item, 32 * MAX_LOG)
            rows[key] = {'type': 'file', 'mode': stat.S_IMODE(st.st_mode), 'bytes': len(data), 'sha256': digest(data)}
    require(rows, 'Empty dependencies')
    return rows


def check_pins(actual, expected):
    require(type(expected) is dict and expected, 'Empty fixture pins')
    for name, sha in expected.items():
        require(name in actual and actual[name]['sha256'] == sha, 'Missing or changed reviewed fixture: ' + name)


def preflight(root=ROOT):
    state = git_state(root)
    source = source_snapshot(root)
    contract = parse_json(read_file(root / 'tooling/integration/account-extensions/CONTRACT.json'))
    check_pins(source, contract['fixtures'])
    link = root / 'source/node_modules'
    require(link.is_symlink() and os.readlink(link) == str(DEPENDENCIES)
            and link.resolve(strict=True) == DEPENDENCIES, 'Expected exact shared node_modules symlink')
    deps = dependency_snapshot()
    require(digest(canonical(deps)) == contract['dependencyManifestSHA256']
            and len(deps) == contract['dependencyEntries'], 'Pinned dependency snapshot changed')
    runtime = parse_json(read_file(root / 'source/runtime-contract.json'))['node']
    node = PINNED_NODE.resolve(strict=True)
    node_ref = ref(node, 128 * MAX_LOG)
    require(node_ref['sha256'] == runtime['executableSHA256'], 'Pinned Node binary changed')
    require(output([str(node), '--version']) == runtime['version'], 'Pinned Node version changed')
    require(os.access(node, os.X_OK) and not node.stat().st_mode & 0o022, 'Unsafe Node executable permissions')
    compiler = Path(output(['/usr/bin/xcrun', '--find', 'swiftc'])).resolve(strict=True)
    sdk = Path(output(['/usr/bin/xcrun', '--sdk', 'macosx', '--show-sdk-path'])).resolve(strict=True)
    settings = sdk / 'SDKSettings.json'
    if not settings.is_file():
        settings = sdk / 'SDKSettings.plist'
    tools = {'node': node_ref, 'nodeInvocation': str(PINNED_NODE), 'nodeVersion': runtime['version'],
             'python': ref(Path(sys.executable).resolve(), 128 * MAX_LOG),
             'sandbox': ref(Path('/usr/bin/sandbox-exec')), 'sandboxProfile': PROFILE,
             'xcrun': ref(Path('/usr/bin/xcrun')), 'swift': ref(compiler, 256 * MAX_LOG),
             'swiftVersion': output([str(compiler), '--version']), 'sdk': str(sdk), 'sdkSettings': ref(settings)}
    require(git_state(root) == state, 'Checkout changed during preflight')
    return {'git': state, 'source': source, 'dependencies': deps, 'tools': tools,
            'nodeModulesLink': {'path': str(link), 'target': os.readlink(link)}}


def tap_result(text):
    lines = text.splitlines()
    require(lines and lines[0] == 'TAP version 13', 'Missing TAP version')
    count = len(TOOL_CASES)
    # The complete top-level named cases are mandatory, not just a summary claiming seven.
    names = re.findall(r'^# Subtest: (.+)$', text, re.M)
    oks = re.findall(r'^ok (\d+) - (.+)$', text, re.M)
    require(names == TOOL_CASES and oks == [(str(i + 1), name) for i, name in enumerate(TOOL_CASES)], 'Missing/duplicate/unknown TAP case')
    require(not re.search(r'(?im)^not ok\b|^ok[^\n]*#\s*(?:SKIP|TODO)\b', text), 'Nonpassing TAP case')
    summaries = {}
    for name in ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        values = re.findall(r'^# ' + name + r' (\d+)$', text, re.M)
        require(len(values) == 1, 'Missing/duplicate TAP summary: ' + name)
        summaries[name] = int(values[0])
    require(summaries == {'tests': count, 'suites': 0, 'pass': count, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, 'Incomplete TAP counts')
    require(re.findall(r'^1\.\.(\d+)$', text, re.M) == [str(count)], 'Missing/duplicate TAP plan')
    require(len(lines) == 1 + 6 * count + 9, 'Unexpected or duplicate TAP metadata')
    tail = ['1..' + str(count), *['# ' + key + ' ' + str(value) for key, value in summaries.items()]]
    require(lines[-9:-1] == tail and re.fullmatch(r'# duration_ms [0-9]+(?:\.[0-9]+)?', lines[-1]), 'TAP summary must be complete and final')
    # Reject unknown lines rather than accepting partial nested results or extra success output.
    allowed = re.compile(r'(?:TAP version 13|# Subtest: .+|ok [1-9][0-9]* - .+|  ---|  duration_ms: [0-9.]+|  type: \'test\'|  \.\.\.|1\.\.[1-9][0-9]*|# (?:tests|suites|pass|fail|cancelled|skipped|todo) [0-9]+|# duration_ms [0-9.]+)')
    require(all(allowed.fullmatch(line) for line in lines), 'Unexpected TAP output')
    return {'testCases': count, 'caseNames': names}


def parse_result(name, text, contract):
    require('\r' not in text and '\x00' not in text and text.endswith('\n'), 'Malformed or unterminated output')
    lines = text.splitlines()
    if name in NATIVE:
        marker = NATIVE[name][2]
        expected = [marker] + ([PARITY] if name == 'external-launch-native' else [])
        if name in STATIC:
            require(len(lines) == len(expected) + 1 and lines[:-1] == expected
                    and canonical(parse_json(lines[-1])) == canonical(STATIC[name]), 'Missing, duplicate or nonfinal native completion')
        else:
            require(lines == expected, 'Missing, duplicate or nonfinal native completion')
        return {'assertions': NATIVE[name][1], 'completionMarkers': expected,
                **({'routingChecks': STATIC[name]} if name in STATIC else {}),
                **({'nodeSwiftParity': True} if name == 'external-launch-native' else {})}
    if name in JS:
        require(lines == [JS[name][1]], 'Missing, duplicate or nonfinal JavaScript completion')
        return {'completionMarkers': lines, **({'durableClaimFamilies': 6} if name == 'external-claims' else {'completedSuites': 1})}
    if name == 'tool-actions':
        return tap_result(text)
    if name in ['runner-adversarial-tests', 'native-evidence-mutations']:
        case_key = 'selfTestCases' if name == 'runner-adversarial-tests' else 'nativeEvidenceTestCases'
        value = parse_json(text)
        require(type(value) is dict and canonical(value) == canonical({'passed': True, 'caseNames': contract[case_key], 'testCases': len(contract[case_key])})
                and value['testCases'] > 0 and len(set(value['caseNames'])) == value['testCases'], 'Incomplete harness tests')
        return value
    raise ValueError('Unknown suite')


def run_bounded(command, cwd, env, log, timeout=180, max_log=MAX_LOG):
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    started = time.monotonic()
    size, failure, proc = 0, None, None
    with os.fdopen(fd, 'wb') as stream:
        try:
            proc = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, start_new_session=True)
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if time.monotonic() - started >= timeout:
                        failure = 'timeout'
                        break
                    for key, _ in selector.select(min(.1, timeout)):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        stream.write(chunk[:max(0, max_log - size)])
                        size += len(chunk)
                        if size > max_log:
                            failure = 'log-bound'
                            break
                    if failure:
                        break
            if not failure:
                try:
                    proc.wait(timeout=max(.01, timeout - (time.monotonic() - started)))
                except subprocess.TimeoutExpired:
                    failure = 'timeout'
        finally:
            if proc is not None:
                # This newly owned process group must not leave descendants after success or failure.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=5)
                proc.stdout.close()
            stream.flush()
            os.fsync(stream.fileno())
    return {'exitCode': proc.returncode, 'failure': failure, 'elapsedSeconds': round(time.monotonic() - started, 3), 'log': ref(log, max_log)}


def fixture_environment(work):
    return {'PATH': '/opt/homebrew/bin:/usr/bin:/bin', 'HOME': str(work / 'home'), 'TMPDIR': str(work / 'tmp') + '/',
            'LANG': 'C', 'LC_ALL': 'C', 'PYTHONDONTWRITEBYTECODE': '1'}


def commands(name, tools, out):
    python = tools['python']['path']
    node = tools['node']['path']
    if name in NATIVE:
        inner = [python, '-B', str(HERE / 'invoke-python.py'), str(ROOT / NATIVE[name][0]), str(out / (name + '.commands.jsonl'))]
    elif name in JS:
        inner = [node, '--preserve-symlinks', str(ROOT / JS[name][0])]
    elif name == 'tool-actions':
        inner = [node, '--preserve-symlinks', '--test', '--test-reporter=tap', str(ROOT / 'tests/tool-actions-check.mjs')]
    elif name == 'native-evidence-mutations':
        inner = [python, '-B', str(HERE / 'test_child_evidence.py'), str(out / 'NATIVE-EVIDENCE.json')]
    elif name == 'agent-syntax':
        inner = [node, '--check', str(ROOT / 'source/agent.mjs')]
    else:
        require(name == 'runner-adversarial-tests', 'Unknown command')
        inner = [python, '-B', str(HERE / 'test_runner.py')]
    return ['/usr/bin/sandbox-exec', '-p', PROFILE, *inner]


# Order, flags, sources and generated inputs are part of each reviewed fixture's
# execution contract. A command count or matching success line is not sufficient.
NATIVE_COMPILE = {
    'private-account-dispatch': ('noiee-account-dispatch-', True, [
        'source/PrivateAccounts.swift', 'source/GitHubAccount.swift', 'source/GmailOAuth.swift',
        'source/GmailAccount.swift', 'source/PrivateAccountsDispatch.swift', '@generated/fixtures.swift',
        'tooling/private_account_dispatch_check.swift']),
    'private-accounts': ('noiee-private-accounts-', True, [
        'source/PrivateAccounts.swift', 'source/PrivateAccountOAuth.swift', 'tooling/private_accounts_check.swift']),
    'github-accounts': ('noiee-github-account-', True, [
        'source/PrivateAccounts.swift', 'source/GitHubAccount.swift', 'tooling/github_accounts_check.swift']),
    'gmail-accounts': ('noiee-gmail-account-', True, [
        'source/PrivateAccounts.swift', 'source/GmailOAuth.swift', 'source/GmailAccount.swift', 'tooling/gmail_accounts_check.swift']),
    'external-install-native': ('noiee-external-compile-', False, [
        'source/CodingTemporary.swift', 'source/ExternalToolInstall.swift', 'tooling/tests/ExternalToolInstallFixture.swift']),
    'external-launch-native': ('noiee-launch-compile-', False, [
        'source/CodingTemporary.swift', 'source/ExternalToolInstall.swift', 'source/ExternalToolLaunch.swift',
        'tooling/tests/ExternalToolLaunchFixture.swift']),
}
PARITY_ARTIFACT = b'throw Error("never executed parity artifact");'


def identity_shape(value, path, limit=256 * MAX_LOG):
    require(type(value) is dict and set(value) == {'path', 'sha256', 'bytes'}
            and value['path'] == str(path) and type(value['bytes']) is int and 0 < value['bytes'] <= limit
            and type(value['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', value['sha256']),
            'Malformed child file/executable identity')
    return value


def source_identity(relative, inputs):
    require(relative in inputs['source'], 'Required native source missing from input snapshot: ' + relative)
    value = inputs['source'][relative]
    return identity_shape({'path': str(ROOT / relative), 'sha256': value['sha256'], 'bytes': value['bytes']}, ROOT / relative)


def bound_source_bytes(relative, inputs):
    expected = source_identity(relative, inputs)
    data = read_file(ROOT / relative)
    require(digest(data) == expected['sha256'] and len(data) == expected['bytes'], 'Current fixture differs from bound source')
    return data


def dispatch_fixture_bytes(inputs):
    fragments = []
    for relative, anchor in [('tooling/github_accounts_check.swift', '@main struct GitHubAccountsCheck'),
                             ('tooling/gmail_accounts_check.swift', '@main struct GmailAccountsCheck')]:
        text = bound_source_bytes(relative, inputs).decode('utf8')
        require(text.count(anchor) == 1, 'Generated dispatch fixture anchor changed')
        fragments.append(text.split(anchor)[0])
    return '\n'.join(fragments).encode('utf8')


def parity_script(inputs):
    import ast
    tree = ast.parse(bound_source_bytes(NATIVE['external-launch-native'][0], inputs))
    assignments = [node.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'script' for target in node.targets)]
    require(len(assignments) == 1 and isinstance(assignments[0], ast.Constant)
            and type(assignments[0].value) is str, 'Expected one literal reviewed parity script')
    return assignments[0].value


def private_temp(path, parent, prefix):
    path = Path(path)
    require(path.is_absolute() and str(path) == os.path.normpath(str(path)) and path.parent == parent
            and re.fullmatch(re.escape(prefix) + r'[a-z0-9_]{8}', path.name), 'Child temporary path outside exact fixture scope')
    return path


def native_compile_contract(name, inputs, work, binary):
    require(name in NATIVE_COMPILE, 'Unknown native fixture')
    prefix, cache, names = NATIVE_COMPILE[name]
    binary = Path(binary)
    require(binary.name == 'check', 'Unexpected compiled binary name')
    tmp = private_temp(binary.parent, work / 'tmp', prefix)
    argv = ['/usr/bin/xcrun', 'swiftc']
    if cache:
        argv.extend(['-parse-as-library', '-module-cache-path', str(tmp / 'modules')])
    refs = {}
    for name in names:
        if name == '@generated/fixtures.swift':
            path = str(tmp / 'fixtures.swift')
            data = dispatch_fixture_bytes(inputs)
            refs[path] = {'path': path, 'bytes': len(data), 'sha256': digest(data)}
        else:
            path = str(ROOT / name)
            refs[path] = source_identity(name, inputs)
        argv.append(path)
    argv.extend(['-o', str(binary)])
    return argv, refs


def audit_result(data, name, inputs, work):
    require(name in NATIVE, 'Unknown native fixture')
    work = Path(work)
    rows = [parse_json(line) for line in data.decode('utf8').splitlines()]
    expected = 4 if name == 'external-launch-native' else 2
    require(len(rows) == expected and [row.get('sequence') for row in rows] == list(range(1, expected + 1)), 'Missing/duplicate child commands')
    for row in rows:
        require(set(row) == {'sequence', 'executable', 'argv', 'cwd', 'executableIdentity', 'inputsBefore', 'inputsAfter', 'outputs', 'exitCode'}
                and type(row['sequence']) is int and type(row['argv']) is list and row['argv']
                and all(type(arg) is str for arg in row['argv']), 'Malformed child command')
        require(type(row['exitCode']) is int and row['exitCode'] == 0 and row['cwd'] == str(ROOT), 'Failed child or changed cwd')
        require(type(row['inputsBefore']) is dict and type(row['inputsAfter']) is dict
                and canonical(row['inputsBefore']) == canonical(row['inputsAfter']), 'Changed or malformed child inputs')
    require(len(rows[1]['argv']) == 1, 'Unexpected native fixture invocation')
    binary = Path(rows[1]['argv'][0])
    binary_ref = identity_shape(rows[1]['executableIdentity'], binary)
    compiler_argv, compiler_inputs = native_compile_contract(name, inputs, work, binary)

    def exact(row, argv, executable, executable_ref, required_inputs, outputs):
        require(row['argv'] == argv and row['executable'] == executable
                and canonical(row['executableIdentity']) == canonical(executable_ref)
                and canonical(row['inputsBefore']) == canonical(required_inputs)
                and canonical(row['inputsAfter']) == canonical(required_inputs)
                and canonical(row['outputs']) == canonical(outputs), 'Child command/input/output differs from exact fixture contract')

    exact(rows[0], compiler_argv, '/usr/bin/xcrun', inputs['tools']['xcrun'], compiler_inputs, [binary_ref])
    exact(rows[1], [str(binary)], str(binary), binary_ref, {}, [])
    if expected == 4:
        require(len(rows[2]['argv']) == 6, 'Missing complete Node parity arguments')
        parent = private_temp(Path(rows[2]['argv'][5]), work / 'home/Library/Caches', 'noiee-review-parity-')
        review_path = str(parent / 'review.json')
        require(type(rows[2]['outputs']) is list and len(rows[2]['outputs']) == 1, 'Missing Node review output')
        review_ref = identity_shape(rows[2]['outputs'][0], review_path, MAX_LOG)
        node_argv = [str(PINNED_NODE), '--input-type=module', '-e', parity_script(inputs),
                     (ROOT / 'source/external-tool-runtime.mjs').as_uri(), str(parent)]
        exact(rows[2], node_argv, str(PINNED_NODE), inputs['tools']['node'], {}, [review_ref])
        runtime = source_identity('source/runtime-contract.json', inputs)
        native_argv = [str(binary), '--validate-review', review_path, runtime['path'], str(parent), digest(PARITY_ARTIFACT)]
        exact(rows[3], native_argv, str(binary), binary_ref, {review_path: review_ref, runtime['path']: runtime}, [])
    return rows



def totals(rows):
    return {'nativeAssertions': sum(row['result'].get('assertions', 0) for row in rows),
            'toolActionTestCases': next(row['result']['testCases'] for row in rows if row['name'] == 'tool-actions'),
            'durableClaimFamilies': 6, 'completionOnlyJSSuites': 5,
            'runnerAdversarialTestCases': rows[0]['result']['testCases'],
            'nativeEvidenceMutationTestCases': next(row['result']['testCases'] for row in rows if row['name'] == 'native-evidence-mutations'),
            'nodeSwiftParity': True, 'agentSyntax': True}


def verify(receipt, expected_hash, expected_commit):
    data = read_file(receipt)
    require(digest(data) == expected_hash, 'Receipt digest differs from caller expectation')
    value = parse_json(data)
    out = safe_path(receipt.parent)
    require(not (out / 'VERIFICATION_FAILED.json').exists(), 'Retained verification failure')
    require(value.get('schemaVersion') == 1 and value.get('kind') == 'noiee-offline-account-extensions'
            and value.get('status') == 'passed' and value.get('complete') is True and value.get('releaseEligible') is False
            and value.get('scope') == SCOPE, 'Not a complete offline qualification receipt')
    before = parse_json(read_ref(value['inputsBefore'], out))
    after = parse_json(read_ref(value['inputsAfter'], out))
    require(before == after and before['git'] == {'commit': expected_commit, 'status': ''}, 'Source/runtime inputs changed or wrong commit')
    require(preflight() == before, 'Receipt is stale for current checkout/runtime/dependencies')
    work = Path(value['fixtureHome'])
    require(work.is_absolute() and work.name.startswith('noiee-account-extensions-')
            and value['environment'] == fixture_environment(work), 'Changed fixture environment')
    contract = parse_json(read_file(HERE / 'CONTRACT.json'))
    rows = value['rows']
    require(type(rows) is list and [row.get('name') for row in rows] == ORDER, 'Missing, duplicate or reordered suite')
    native_bundle = parse_json(read_ref(value['nativeEvidence'], out))
    require(canonical(native_bundle) == canonical({'inputs': value['inputsBefore'], 'fixtureHome': value['fixtureHome'],
                                                  'rows': [row for row in rows if row['name'] in NATIVE]}), 'Fresh native evidence bundle differs')
    references = [value['inputsBefore']['path'], value['inputsAfter']['path'], value['nativeEvidence']['path']]
    for row in rows:
        name = row['name']
        require(row['exitCode'] == 0 and type(row['exitCode']) is int and row['failure'] is None and row['cwd'] == str(ROOT)
                and row['command'] == commands(name, before['tools'], out), 'Failed/incomplete/altered command')
        references.append(row['log']['path'])
        text = read_ref(row['log'], out, MAX_LOG).decode('utf8', errors='strict')
        expected = {'syntaxOnly': True} if name == 'agent-syntax' and text == '' else parse_result(name, text, contract)
        require(canonical(row['result']) == canonical(expected), 'Parsed result differs from retained log')
        if name in NATIVE:
            references.append(row['childCommands']['path'])
            audit_result(read_ref(row['childCommands'], out, MAX_LOG), name, before, work)
    require(len(references) == len(set(references)), 'Duplicate evidence reference')
    require(canonical(value['totals']) == canonical(totals(rows)), 'Totals differ from complete results')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('run')
    check = sub.add_parser('verify')
    check.add_argument('--receipt', required=True, type=Path)
    check.add_argument('--sha256', required=True)
    check.add_argument('--commit', required=True)
    args = parser.parse_args()
    if args.action == 'verify':
        verify(args.receipt.absolute(), args.sha256, args.commit)
        print(json.dumps({'verified': True, 'receipt': str(args.receipt), 'sha256': args.sha256, 'commit': args.commit, 'releaseEligible': False}))
        return 0
    base = ROOT / '.artifacts/integration'
    base.mkdir(parents=True, mode=0o700, exist_ok=True)
    safe_path(base)
    out = Path(tempfile.mkdtemp(prefix='account-extensions-', dir=base))
    rows = []
    result = {'schemaVersion': 1, 'kind': 'noiee-offline-account-extensions', 'runId': str(uuid.uuid4()),
              'status': 'failed', 'complete': False, 'releaseEligible': False, 'scope': SCOPE, 'rows': rows,
              'startedUTC': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        before = preflight()
        result['inputsBefore'] = save_new(out / 'INPUTS.before.json', before)
        contract = parse_json(read_file(HERE / 'CONTRACT.json'))
        with tempfile.TemporaryDirectory(prefix='noiee-account-extensions-', dir=Path.home() / 'Library/Caches') as tmp:
            work = Path(tmp)
            (work / 'home/Library/Caches').mkdir(parents=True, mode=0o700)
            (work / 'tmp').mkdir(mode=0o700)
            env = fixture_environment(work)
            result['fixtureHome'] = str(work)
            result['environment'] = env
            for name in ORDER:
                if name == 'native-evidence-mutations':
                    result['nativeEvidence'] = save_new(out / 'NATIVE-EVIDENCE.json',
                        {'inputs': result['inputsBefore'], 'fixtureHome': str(work), 'rows': [row for row in rows if row['name'] in NATIVE]})
                command = commands(name, before['tools'], out)
                row = {'name': name, 'command': command, 'cwd': str(ROOT),
                       **run_bounded(command, ROOT, env, out / (name + '.log'))}
                rows.append(row)
                require(row['exitCode'] == 0 and row['failure'] is None, name + ' execution failed')
                text = read_file(out / (name + '.log'), MAX_LOG).decode('utf8', errors='strict')
                row['result'] = {'syntaxOnly': True} if name == 'agent-syntax' and text == '' else parse_result(name, text, contract)
                if name in NATIVE:
                    path = out / (name + '.commands.jsonl')
                    audit_result(read_file(path, MAX_LOG), name, before, work)
                    row['childCommands'] = ref(path, MAX_LOG)
                print(json.dumps({'suite': name, 'passed': True, 'result': row['result']}), flush=True)
        after = preflight()
        result['inputsAfter'] = save_new(out / 'INPUTS.after.json', after)
        require(before == after, 'Source/runtime/dependency inputs changed during execution')
        result.update(status='passed', complete=True, totals=totals(rows))
    except Exception as error:
        result['error'] = str(error)
    result['completedUTC'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    receipt = save_new(out / 'RESULT.json', result)
    if result['complete']:
        try:
            verify(Path(receipt['path']), receipt['sha256'], before['git']['commit'])
        except Exception as error:
            # Never overwrite evidence, nor emit a success receipt after verification fails.
            save_new(out / 'VERIFICATION_FAILED.json', {'error': str(error), 'receipt': receipt})
            print(json.dumps({'passed': False, 'error': str(error), 'receipt': receipt}), flush=True)
            return 1
    print(json.dumps({'passed': result['complete'], 'receipt': receipt, 'totals': result.get('totals'), 'error': result.get('error')}), flush=True)
    return 0 if result['complete'] else 1


if __name__ == '__main__':
    sys.exit(main())
