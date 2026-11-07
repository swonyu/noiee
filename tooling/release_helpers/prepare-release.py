"""Root-run preparation from reviewed, freshly observed inputs; never installs or launches."""
from pathlib import Path
import argparse
import datetime
import json
import os
import plistlib
import runpy
import shutil
import stat
import subprocess

BASE = Path(__file__).resolve().parent.parent
shared = runpy.run_path(str(BASE / 'scripts/build-candidate.py'))
globals().update({key:value for key,value in shared.items() if not key.startswith('__') and key != 'main'})


def approved_plist(content):
    info = plistlib.loads(content)
    info['CFBundleVersion'] = '40'
    info['NSLocalNetworkUsageDescription'] = 'Connects to the isolated coding workspace running on this Mac.'
    return plistlib.dumps(info)


def copy_exact(original, target, expected):
    """Hash the same buffer we copy; preserve exact modes and internal symlink targets."""
    target.mkdir(mode=expected['.']['mode'])
    for name,row in expected.items():
        if name == '.':
            continue
        source, destination = original / name, target / name
        if row['type'] == 'directory':
            destination.mkdir(mode=row['mode'])
            destination.chmod(row['mode'])
        elif row['type'] == 'symlink':
            require(not Path(row['target']).is_absolute() and source.resolve(strict=True).is_relative_to(original),
                    'Dependency link escapes its frozen namespace: ' + name)
            destination.symlink_to(row['target'])
            os.chmod(destination, row['mode'], follow_symlinks=False)
        else:
            content = source.read_bytes()
            require(digest(content) == row['sha256'] and len(content) == row['size'], 'Copy input changed: ' + name)
            write_new(destination, content, row['mode'])
    target.chmod(expected['.']['mode'])
    require(manifest(original, True) == expected == manifest(target, True), 'Complete dependency copy differs.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-approved-build40', action='store_true')
    parser.add_argument('--capture-approved-baseline', action='store_true')
    parser.add_argument('--signing-identity')
    parser.add_argument('--inputs', type=Path)
    parser.add_argument('--inputs-sha256')
    args = parser.parse_args()
    if args.capture_approved_baseline:
        require(not args.prepare_approved_build40 and re.fullmatch('[0-9A-F]{40}', args.signing_identity or ''), 'Baseline capture requires the freshly reviewed signing identity.')
        available = subprocess.check_output(['/usr/bin/security','find-identity','-v','-p','codesigning'], text=True)
        require(args.signing_identity in available, 'Current signing identity unavailable.')
        (BASE / 'inputs').mkdir(mode=0o700, exist_ok=True)
        require_stopped()
        boot = boot_session(); contents, identities = data_snapshot(); bundle = manifest(APP)
        info = plistlib.loads((APP / 'Contents/Info.plist').read_bytes())
        require((info.get('CFBundleIdentifier'),info.get('CFBundleExecutable'),info.get('CFBundleShortVersionString')) ==
                ('com.saleh.qwenlocal.chat','QwenLocal','1.3'), 'Unexpected production app identity.')
        value = {'observedAt':now(),'installedApp':str(APP),'installedBuild':info['CFBundleVersion'],'bundleManifest':bundle,
                 'dataManifests':contents,'dataIdentities':identities,'bootSession':boot,'signingIdentity':args.signing_identity,
                 'designatedRequirement':requirement(APP)}
        require_stopped(); verify_data(value)
        require(manifest(APP) == bundle and boot_session() == boot, 'Baseline changed during capture.')
        destination = BASE / 'inputs/baseline.json'
        write_new(destination, json.dumps(value,indent=2).encode() + b'\n')
        print(str(destination) + ' SHA256 ' + sha(destination))
        return
    require(args.prepare_approved_build40, 'Explicit reviewed preparation flag required.')
    require(args.inputs is not None and args.inputs_sha256, 'Reviewed release inputs and digest required.')
    ref = {'path': str(args.inputs.resolve(strict=True)), 'sha256': args.inputs_sha256}
    inputs = read_ref(ref)
    require(set(inputs) == {'schemaVersion','sourceDirectory','sourceIntegration','baseline','acceptance','closure',
                           'configuration','assets','signing','preserveResources','intentPath'}, 'Unknown or incomplete release input fields.')
    require(inputs['schemaVersion'] == 1, 'Unknown release input schema.')
    begin_attempt(BASE / 'preparation-attempt.json', {'at': now(), 'input': ref})
    os.umask(0o077)
    integration = read_ref(inputs['sourceIntegration'])
    original = Path(inputs['sourceDirectory'])
    require(original.resolve(strict=True) == original and integration.get('frozen') is True
            and len(integration['sourcePins']) == 129, 'Expected reviewed canonical 129-file source snapshot.')
    original_manifest = manifest(original, True)
    require({p.name for p in original.iterdir() if not p.is_symlink()} == set(integration['sourcePins'])
            and {p.name:os.readlink(p) for p in original.iterdir() if p.is_symlink()} == integration['symlinks'], 'Frozen source namespace differs.')
    require(set(integration['symlinks']) == {'node_modules'}, 'Unexpected source links.')
    baseline = read_ref(inputs['baseline'])
    require(set(baseline) == {'observedAt','installedApp','installedBuild','bundleManifest','dataManifests','dataIdentities',
                             'bootSession','signingIdentity','designatedRequirement'}, 'Unknown/incomplete fresh baseline.')
    age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(baseline['observedAt'])).total_seconds()
    require(0 <= age <= 1800 and baseline['installedApp'] == str(APP) and baseline['installedBuild'] != '40', 'Baseline missing, stale, or already Build40.')
    signing = inputs['signing']
    require(set(signing) == {'identity','designatedRequirement'} and re.fullmatch('[0-9A-F]{40}', signing['identity'])
            and signing['identity'] == baseline['signingIdentity'] and signing['designatedRequirement'] == baseline['designatedRequirement'],
            'Fresh explicit certificate/requirement mismatch.')
    available = subprocess.check_output(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'], text=True)
    require(signing['identity'] in available, 'Reviewed signing identity is unavailable.')
    source = {'schemaVersion':1, 'candidateBuild':'40', 'inputs':inputs, 'releaseInput':ref}
    require_stopped(); verify_data(baseline); verify_installed(source, baseline)
    require(boot_session() == baseline['bootSession'], 'Fresh kernel boot identity differs.')
    verify_evidence(inputs, integration)
    configuration = read_ref(inputs['configuration'])
    accepted = read_ref(read_ref(inputs['acceptance'])['package'])['configuration']
    require(set(configuration) == {'dataDir','executor','limits'}, 'Unknown owned runtime fields.')
    expected = json.loads(json.dumps(accepted))
    expected['dataDir'] = str(CODING)
    expected['executor']['runtimeDir'] = str(EXECUTORS)
    for key in ['image','helpers']:
        expected['executor'][key] = configuration['executor'][key]
    expected['executor']['bundle']['path'] = configuration['executor']['bundle']['path']
    require(configuration == expected, 'Production config changes exceed the approved path relocation.')
    allocation = {'cpu':6, 'memoryBytes':8*1024**3, 'diskBytes':64*1024**3}
    executor = configuration['executor']
    require(executor['resources'] == allocation and configuration['limits'] == {**allocation,'concurrent':1}
            and executor['account']['user'] == 'saleh' and executor['startupTimeoutMs'] == 1500000,
            'Tested capacity/account/startup policy changed.')
    asset_paths = [executor['image'], executor['bundle']['path'], *executor['helpers'].values()]
    require(set(executor['helpers']) == {'install','vm','key'} and all(Path(p).is_relative_to(ASSETS) and Path(p).resolve(strict=True) == Path(p) for p in asset_paths),
            'Runtime assets must have final canonical paths under Build40.')
    assets = read_ref(inputs['assets'])
    require(set(assets) == {'root','manifest','restore','helperRequirements'} and set(assets['helperRequirements']) == set(executor['helpers'].values()),
            'Asset helper signature manifest is incomplete.')
    require(assets['restore']['path'] == executor['image'], 'Restore manifest and runtime config disagree.')
    restore = assets['restore']
    require(identity(Path(restore['originalPath']), True) == restore['originalIdentity'], 'Original restore identity changed.')
    require(identity(Path(restore['path']), True) == restore['installedIdentity'] and restore['installedIdentity']['mode'] == 0o600
            and (restore['originalIdentity']['dev'],restore['originalIdentity']['ino']) != (restore['installedIdentity']['dev'],restore['installedIdentity']['ino']),
            'Restore clone is unsafe or aliases its original.')
    subprocess.run(['/usr/bin/cmp', '-s', restore['originalPath'], restore['path']], check=True)
    require(identity(Path(restore['originalPath']), True) == restore['originalIdentity']
            and identity(Path(restore['path']), True) == restore['installedIdentity'], 'Restore changed during comparison.')
    require(EXECUTORS.is_dir() and not EXECUTORS.is_symlink() and EXECUTORS.stat().st_uid == os.getuid()
            and not EXECUTORS.stat().st_mode & 0o077, 'Private allocation directory must be explicitly prepared by root.')
    source['executorIdentity'] = identity(EXECUTORS)
    capacity = os.statvfs(EXECUTORS)
    source['availableBytesAtPreparation'] = capacity.f_bavail * capacity.f_frsize
    require(source['availableBytesAtPreparation'] >= allocation['diskBytes'], 'Insufficient physical capacity for the tested 64 GiB allocation.')
    bundle = executor['bundle']
    require(sha(Path(bundle['path'])) == bundle['sha256'] and Path(bundle['path']).stat().st_size == bundle['bytes'], 'Bootstrap bundle bytes changed.')
    for path in executor['helpers'].values():
        require(Path(path).stat().st_mode & 0o111, 'Runtime helper is not executable.')
    intent = Path(inputs['intentPath'])
    require(intent.parent == INTENTS and re.fullmatch(r'Build40-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json', intent.name)
            and not intent.exists() and not intent.is_symlink() and INTENTS.resolve(strict=True) == INTENTS
            and INTENTS.stat().st_uid == os.getuid() and not INTENTS.stat().st_mode & 0o077, 'Private fresh intent location is required.')
    source['intentDirectoryIdentity'] = identity(INTENTS)
    verify_assets(source)
    SOURCE.mkdir(mode=0o700)
    approved = {}
    for name,pin in integration['sourcePins'].items():
        content = (original / name).read_bytes()
        require(digest(content) == pin, 'Frozen source changed: ' + name)
        if name == 'App.swift':
            before = 'Saleh Uncensored 1.3 — Build 39'.encode()
            require(content.count(before) == 1, 'About transformation is ambiguous.')
            content = content.replace(before, 'Saleh Uncensored 1.3 — Build 40'.encode())
        write_new(SOURCE / name, content, original_manifest[name]['mode'])
        approved[name] = digest(content)
    dependencies = (original / 'node_modules').resolve(strict=True)
    dependency_manifest = manifest(dependencies, True)
    copy_exact(dependencies, BASE / 'dependencies', dependency_manifest)
    (SOURCE / 'node_modules').symlink_to('../dependencies')
    resources = BASE / 'resources'; resources.mkdir(mode=0o700)
    for name in approved:
        if Path(name).suffix in {'.mjs','.js','.json','.html','.css','.exp','.txt'}:
            require(name not in {'mcp.json','owned-runtime.json','legacy-admission.json'}, 'Source collides with protected configuration.')
            write_new(resources / name, (SOURCE / name).read_bytes(), 0o700 if original_manifest[name]['mode'] & 0o111 else 0o600)
    require(stat.S_IMODE((resources / 'guest-ssh.exp').stat().st_mode) == 0o700, 'SSH helper executable mode is required.')
    copy_exact(BASE / 'dependencies', resources / 'node_modules', dependency_manifest)
    preserve = inputs['preserveResources']
    require(isinstance(preserve,list) and len(set(preserve)) == len(preserve), 'Invalid preserved resource list.')
    for name in preserve:
        require(Path(name).name == name and name not in {'mcp.json','owned-runtime.json','legacy-admission.json','legacy-boot-helper'}, 'Invalid preserved resource.')
        old = APP / 'Contents/Resources' / name
        require(old.is_file() and not old.is_symlink() and not (resources / name).exists(), 'Only explicit nonconflicting regular resources may be preserved.')
        row = baseline['bundleManifest']['Contents/Resources/' + name]
        content = old.read_bytes(); require(digest(content) == row['sha256'], 'Preserved baseline resource changed.')
        write_new(resources / name, content, row['mode'])
    write_new(resources / 'owned-runtime.json', compact(configuration) + b'\n', 0o600)
    write_new(BASE / 'approved-Info.plist', approved_plist((APP / 'Contents/Info.plist').read_bytes()),
              baseline['bundleManifest']['Contents/Info.plist']['mode'])
    source.update(approvedSourceSHA256=approved, originalSourceManifest=original_manifest, sourceManifest=manifest(SOURCE, True),
                  dependencySource=str(dependencies), dependencyManifest=dependency_manifest, resourceManifest=manifest(resources),
                  plistEntry=manifest(BASE / 'approved-Info.plist', True)['.'], scriptInputsSHA256=release_check_inputs())
    require({name:row['sha256'] for name,row in source['sourceManifest'].items() if row['type'] == 'file'} == approved,
            'Copied source changed before freeze.')
    for name,row in source['resourceManifest'].items():
        if name in approved:
            require(row.get('sha256') == approved[name], 'Copied resource changed before freeze: ' + name)
    source['resourceDeltaBeforeProof'] = delta(resources_view(baseline['bundleManifest']), source['resourceManifest'])
    source['generatedResources'] = {'legacy-boot-helper': {'type':'file','mode':0o555}, 'legacy-admission.json': {'type':'file','mode':0o444}}
    source['approvedResourceDelta'] = delta(resources_view(baseline['bundleManifest']),
                                            {**source['resourceManifest'], **source['generatedResources']})
    require(manifest(original, True) == original_manifest, 'Original source changed during preparation.')
    require_stopped(); verify_data(baseline); verify_installed(source, baseline); verify_assets(source)
    save(BASE / 'source-manifest.json', source)
    print('Prepared Build40 frozen manifest: ' + sha(BASE / 'source-manifest.json'))
    print('Review resourceDeltaBeforeProof and generatedResources before the explicit release command.')


if __name__ == '__main__':
    main()
