"""Frozen combined Build40 compiler and shared guards. No install or UI launch."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import uuid

BASE = Path(__file__).resolve().parent.parent
SOURCE = BASE / 'source'
APP = Path('/Users/saleh/Applications/Saleh Uncensored.app')
SUPPORT = Path('/Users/saleh/Library/Application Support')
CODING = SUPPORT / 'Qwen Local/Coding'
ASSETS = SUPPORT / 'Saleh Uncensored Runtime/Build40'
EXECUTORS = SUPPORT / 'Saleh Uncensored Runtime/Executors'
INTENTS = SUPPORT / 'Saleh Uncensored Runtime/Release Intents'
DATA_ROOTS = {
    'Qwen Local': SUPPORT / 'Qwen Local',
    'WebKit': Path('/Users/saleh/Library/WebKit/com.saleh.qwenlocal.chat'),
    'HTTPStorages': Path('/Users/saleh/Library/HTTPStorages/com.saleh.qwenlocal.chat'),
    'preferences.plist': Path('/Users/saleh/Library/Preferences/com.saleh.qwenlocal.chat.plist'),
}
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
digest = lambda value: hashlib.sha256(value).hexdigest()
compact = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, content, mode=0o600):
    """Exclusive creation: a partial write is retained and refuses automatic replay."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())
    sync_dir(path.parent)


def save(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    write_new(temporary, json.dumps(value, indent=2).encode() + b'\n')
    os.replace(temporary, path)
    sync_dir(path.parent)


def begin_attempt(path, value):
    write_new(path, compact(value) + b'\n')


def identity(path, content_times=False):
    path = Path(path)
    require(not path.is_symlink() and path.resolve(strict=True) == path, 'Noncanonical identity: ' + str(path))
    info = path.lstat()
    row = {'path': str(path), 'dev': str(info.st_dev), 'ino': str(info.st_ino), 'uid': info.st_uid}
    if content_times:
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Unsafe asset file: ' + str(path))
        row.update(size=info.st_size, mode=stat.S_IMODE(info.st_mode), nlink=info.st_nlink,
                   mtimeNs=info.st_mtime_ns, ctimeNs=info.st_ctime_ns)
    return row


def manifest(root, include_root=False, identity_only=None):
    root = Path(root)
    require(root.exists() and not root.is_symlink(), 'Missing or symlink manifest root: ' + str(root))
    result = {}
    def visit(path):
        info = path.lstat()
        key = '.' if path == root else str(path.relative_to(root))
        row = {'mode': stat.S_IMODE(info.st_mode)}
        if stat.S_ISLNK(info.st_mode):
            row.update(type='symlink', target=os.readlink(path))
        elif stat.S_ISREG(info.st_mode):
            row.update(type='file', size=info.st_size)
            if key == identity_only:
                row['identity'] = identity(path, True)
            else:
                row['sha256'] = sha(path)
        elif stat.S_ISDIR(info.st_mode):
            row['type'] = 'directory'
        else:
            raise RuntimeError('Unexpected special file: ' + str(path))
        if path != root or include_root:
            result[key] = row
        if stat.S_ISDIR(info.st_mode):
            for child in sorted(path.iterdir()):
                visit(child)
    visit(root)
    return result


def pinned(ref):
    require(set(ref) == {'path', 'sha256'}, 'A pinned input needs exactly path and sha256.')
    path = Path(ref['path'])
    require(path.is_absolute() and path.is_file() and not path.is_symlink() and sha(path) == ref['sha256'],
            'Pinned input changed: ' + str(path))
    return path


def read_ref(ref):
    content = pinned(ref).read_bytes()
    require(digest(content) == ref['sha256'], 'Pinned JSON changed while reading: ' + ref['path'])
    return json.loads(content)


def requirement(path, deep=True):
    subprocess.run(['/usr/bin/codesign', '--verify'] + (['--deep'] if deep else []) + ['--strict', str(path)],
                   capture_output=True, check=True)
    result = subprocess.run(['/usr/bin/codesign', '-d', '-r-', str(path)], capture_output=True, text=True, check=True)
    return next(line for line in (result.stdout + result.stderr).splitlines() if line.startswith('designated =>'))


def boot_session():
    value = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], text=True).strip()
    require(re.fullmatch(r'[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}', value), 'Unknown kernel boot identity.')
    return value


def data_snapshot():
    identities, contents = {}, {}
    for name, path in {**DATA_ROOTS, 'Coding identity': CODING}.items():
        require(not path.is_symlink(), 'Data root is a symlink: ' + name)
        identities[name] = identity(path) if path.exists() else None
        if name != 'Coding identity':
            contents[name] = manifest(path, True) if path.exists() else None
    require(identities['Coding identity'] is not None and CODING.is_dir(), 'Original Coding directory must exist.')
    require(CODING.stat().st_uid == os.getuid() and not CODING.stat().st_mode & 0o077,
            'Coding directory must be owned and private.')
    return contents, identities


def verify_data(baseline):
    contents, identities = data_snapshot()
    require(contents == baseline['dataManifests'], 'App data changed; automatic downgrade is forbidden.')
    require(identities == baseline['dataIdentities'], 'Original data directory/file identities changed.')


def verify_installed(source, baseline):
    require(manifest(APP) == baseline['bundleManifest'], 'Installed baseline changed.')
    info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
    require((info.get('CFBundleIdentifier'), info.get('CFBundleExecutable'), info.get('CFBundleShortVersionString'), info.get('CFBundleVersion')) ==
            ('com.saleh.qwenlocal.chat', 'QwenLocal', '1.3', baseline['installedBuild']), 'Baseline app identity changed.')
    require(requirement(APP) == source['inputs']['signing']['designatedRequirement'] == baseline['designatedRequirement'],
            'Installed signing requirement changed.')


class StoppedStateRefusal(RuntimeError):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def require_stopped():
    try:
        for field in ['comm=', 'command=']:
            rows = subprocess.check_output(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,' + field], text=True)
            require(bool(rows.strip()), 'Process inventory unavailable.')
            for line in rows.splitlines():
                parts = line.strip().split(None, 2)
                require(len(parts) == 3, 'Incomplete process inventory.')
                command = parts[2]
                markers = [str(APP), str(BASE / 'source/server.mjs'), 'model_providers.saleh_local.',
                           str(SUPPORT / 'Qwen Local') + '/', str(EXECUTORS) + '/', str(ASSETS) + '/']
                if any(marker in command for marker in markers) or (field == 'comm=' and Path(command).name == 'QwenLocal'):
                    raise StoppedStateRefusal('observed-writer', 'App or potentially owned process is running; release paused.')
        result = subprocess.run(['/usr/sbin/lsof', '-nP', '-iTCP:8787', '-sTCP:LISTEN', '-Fpc'], capture_output=True, text=True)
        require(result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip(), 'Port 8787 active or unknown.')
    except StoppedStateRefusal:
        raise
    except Exception as error:
        raise StoppedStateRefusal('stopped-state-unknown', str(error)) from error


def verify_assets(source):
    assets = read_ref(source['inputs']['assets'])
    restore = assets['restore']
    require(assets['root'] == str(ASSETS) and Path(restore['path']).is_relative_to(ASSETS), 'Wrong permanent asset paths.')
    require(identity(Path(restore['path']), True) == restore['installedIdentity'], 'Restore image identity changed.')
    require(manifest(ASSETS, True, str(Path(restore['path']).relative_to(ASSETS))) == assets['manifest'],
            'Complete runtime asset namespace changed.')
    require(identity(EXECUTORS) == source['executorIdentity'] and list(EXECUTORS.iterdir()) == [], 'Executor allocation directory changed or is not empty.')
    for path, expected in assets['helperRequirements'].items():
        require(requirement(Path(path), False) == expected, 'Runtime helper signature changed: ' + path)
    require(identity(INTENTS) == source['intentDirectoryIdentity'] and INTENTS.stat().st_uid == os.getuid()
            and not INTENTS.stat().st_mode & 0o077, 'Private intent directory identity or permissions changed.')


def verify_evidence(inputs, integration):
    acceptance = read_ref(inputs['acceptance'])
    require(acceptance.get('nativeAcceptancePassed') is True and acceptance.get('physicalClosurePassed') is True
            and acceptance.get('integrationSHA256') == inputs['sourceIntegration']['sha256']
            and acceptance.get('sourcePins') == integration['sourcePins'], 'Actual package-bound native acceptance/closure is missing or unbound.')
    package = read_ref(acceptance['package'])
    require(package.get('passed') is True and package['sourcePins'] == integration['sourcePins'], 'Accepted package source map differs.')
    require(acceptance.get('evidence') and acceptance.get('reusedChecks'), 'Acceptance and reused legacy/v9 evidence are required.')
    for ref in acceptance['evidence']:
        pinned(ref)
    for check in acceptance['reusedChecks']:
        require(check.get('exitCode') == 0 and check.get('command') and check.get('inputs'), 'Incomplete reused check binding.')
        pinned(check['receipt'])
        for ref in check['inputs']:
            pinned(ref)
    closure = read_ref(inputs['closure'])
    baseline = read_ref(inputs['baseline'])
    require(closure.get('reviewedClosed') is True and closure.get('baselineSHA256') == inputs['baseline']['sha256']
            and closure.get('bootSession') == baseline['bootSession'] and closure.get('evidence'), 'Current owned closure evidence is missing or unbound.')
    for ref in closure['evidence']:
        pinned(ref)
    require(not os.path.lexists(CODING / 'coding-owners.lock'), 'Owner lease present; explicit recovery required.')


def resources_view(bundle):
    return {name.removeprefix('Contents/Resources/'): row for name, row in bundle.items() if name.startswith('Contents/Resources/')}


def delta(before, after):
    return {'added': sorted(set(after) - set(before)), 'removed': sorted(set(before) - set(after)),
            'changed': sorted(name for name in set(before) & set(after) if before[name] != after[name])}


def verify_candidate(app, source, baseline, generated=None):
    """Every path is exact; only the two explicitly generated payloads are supplied later."""
    actual = manifest(app)
    expected = {name: row for name, row in baseline['bundleManifest'].items()
                if not name.startswith('Contents/Resources/') and not name.startswith('Contents/_CodeSignature')}
    expected.update({'Contents/Resources/' + name: row for name, row in source['resourceManifest'].items()})
    expected['Contents/Info.plist'] = source['plistEntry']
    expected.update(generated or {})
    ignored = {'Contents/MacOS/QwenLocal', 'Contents/_CodeSignature', 'Contents/_CodeSignature/CodeResources'}
    require({k:v for k,v in actual.items() if k not in ignored} == {k:v for k,v in expected.items() if k not in ignored},
            'Candidate exact namespace, bytes, modes or symlink targets differ.')
    binary = actual.get('Contents/MacOS/QwenLocal', {})
    require(binary.get('type') == 'file' and binary.get('mode') == 0o700, 'Native executable mode/type changed.')
    require((app / 'Contents/Info.plist').read_bytes() == (BASE / 'approved-Info.plist').read_bytes(), 'Approved plist differs.')
    return actual


def release_check_inputs():
    return {str(path.relative_to(BASE)): sha(path) for folder in ['scripts', 'checks']
            for path in sorted((BASE / folder).glob('*')) if path.is_file() and path.suffix in {'.py', '.mjs', '.js', '.swift'}}


def gate_commands():
    import sys
    return [('installer-fixtures', [sys.executable, str(BASE / 'checks/release-check.py')])]


def require_gates(source):
    receipt = json.loads((BASE / 'checks/release-gates.json').read_bytes())
    require(receipt.get('complete') is True and receipt.get('candidateBuild') == '40'
            and receipt.get('sourceManifestSHA256') == sha(BASE / 'source-manifest.json')
            and receipt.get('checkInputsSHA256') == release_check_inputs()
            and receipt.get('checks') == [{'name': name, 'command': args, 'exitCode': 0} for name,args in gate_commands()],
            'Current exact release gates have not passed.')


def load_inputs():
    source = json.loads((BASE / 'source-manifest.json').read_bytes())
    require(source.get('schemaVersion') == 1 and source.get('candidateBuild') == '40', 'Unknown release schema/build.')
    inputs = source['inputs']
    require(read_ref(source['releaseInput']) == inputs, 'Reviewed release input changed.')
    integration = read_ref(inputs['sourceIntegration'])
    baseline = read_ref(inputs['baseline'])
    verify_evidence(inputs, integration)
    require(release_check_inputs() == source['scriptInputsSHA256'], 'Release implementation/check inputs changed.')
    require(manifest(SOURCE, True) == source['sourceManifest'], 'Complete source namespace changed.')
    require({name:row['sha256'] for name,row in source['sourceManifest'].items() if row['type'] == 'file'} == source['approvedSourceSHA256'],
            'Candidate source content differs from the exact approved successor map.')
    for name,row in source['resourceManifest'].items():
        if name in source['approvedSourceSHA256']:
            require(row.get('sha256') == source['approvedSourceSHA256'][name], 'Resource/source pin mismatch: ' + name)
    require(manifest(Path(inputs['sourceDirectory']), True) == source['originalSourceManifest'], 'Original frozen source namespace changed.')
    require(manifest(BASE / 'dependencies', True) == source['dependencyManifest'], 'Complete dependency namespace changed.')
    require(manifest(BASE / 'resources') == source['resourceManifest'], 'Frozen resource namespace changed.')
    require(sha(BASE / 'approved-Info.plist') == source['plistEntry']['sha256'], 'Approved plist changed.')
    require(boot_session() == baseline['bootSession'], 'Boot changed during release; prepare a fresh baseline.')
    verify_assets(source)
    return source, baseline


def main():
    begin_attempt(BASE / 'compile-attempt.json', {'at': now(), 'build': '40'})
    source, baseline = load_inputs()
    require_gates(source)
    require_stopped(); verify_data(baseline); verify_installed(source, baseline)
    stage = BASE / 'candidate'
    stage.mkdir(mode=0o700)
    app = stage / APP.name
    subprocess.run(['/usr/bin/ditto', str(APP), str(app)], check=True)
    require(manifest(app) == baseline['bundleManifest'], 'Copied baseline bundle differs.')
    shutil.rmtree(app / 'Contents/Resources')
    shutil.copytree(BASE / 'resources', app / 'Contents/Resources', symlinks=True)
    (app / 'Contents/Resources').chmod(baseline['bundleManifest']['Contents/Resources']['mode'])
    shutil.copyfile(BASE / 'approved-Info.plist', app / 'Contents/Info.plist')
    (app / 'Contents/Info.plist').chmod(source['plistEntry']['mode'])
    native = sorted(name for name in integration_sources(source) if name.endswith('.swift'))
    require(len(native) == 15, 'Exactly fifteen approved Swift inputs must compile.')
    args = ['/usr/bin/xcrun', 'swiftc', '-O', '-target', 'arm64-apple-macos15.2', '-parse-as-library',
            '-module-cache-path', str(BASE / 'module-cache')]
    for framework in ['AppKit','WebKit','UniformTypeIdentifiers','ScreenCaptureKit','ApplicationServices','Contacts','Security']:
        args += ['-framework', framework]
    args += [str(SOURCE / name) for name in native] + ['-o', str(app / 'Contents/MacOS/QwenLocal')]
    result = subprocess.run(args, capture_output=True, text=True)
    (BASE / 'checks/compile.log').write_text(result.stdout + result.stderr)
    receipt = {'at': now(), 'build': '40', 'candidate': str(app), 'command': args, 'compileExit': result.returncode,
               'nativeSHA256': {name:sha(SOURCE / name) for name in native},
               'sourceManifestSHA256': sha(BASE / 'source-manifest.json'), 'uiLaunched': False, 'installed': False}
    if result.returncode == 0:
        (app / 'Contents/MacOS/QwenLocal').chmod(0o700)
        verify_candidate(app, source, baseline)
        receipt['unsignedBinarySHA256'] = sha(app / 'Contents/MacOS/QwenLocal')
        check = subprocess.run([str(app / 'Contents/MacOS/QwenLocal'), '--check-computer'], capture_output=True, text=True, timeout=60)
        (BASE / 'checks/native-selfcheck.log').write_text(check.stdout + check.stderr)
        receipt['nativeSelfcheckExit'] = check.returncode
    load_inputs(); require_stopped(); verify_data(baseline); verify_installed(source, baseline)
    save(BASE / 'compile.json', receipt)
    raise SystemExit(result.returncode or receipt.get('nativeSelfcheckExit', 1))


def integration_sources(source):
    return source['approvedSourceSHA256']


if __name__ == '__main__':
    main()
