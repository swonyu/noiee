"""Root-only Build40 install. No launch, signals, data restore, migration or disk cleanup."""
from pathlib import Path
import argparse
import json
import os
import plistlib
import runpy
import subprocess
import uuid

BASE = Path(__file__).resolve().parent.parent
shared = runpy.run_path(str(BASE / 'scripts/build-candidate.py'))
globals().update({key:value for key,value in shared.items() if not key.startswith('__') and key != 'main'})
verify_proof = runpy.run_path(str(BASE / 'scripts/sign-package.py'))['verify_proof']


def observe_model_listener():
    result = subprocess.run(['/usr/sbin/lsof','-nP','-iTCP:1234','-sTCP:LISTEN','-Fpc'], capture_output=True, text=True)
    observed = result.returncode in [0,1] and not result.stderr.strip()
    return {'port':1234,'observedAt':now(),'observed':observed,'listening':bool(result.stdout.strip()) if observed else None,
            'informationalOnly':True,'stopOrRestartRequested':False}


def replace_bundle(app, candidate, old, before, expected, journal_path, journal, check_data, check_stopped, postcheck):
    """The only rollback entry is this synchronous transaction; there is no resume/downgrade command."""
    def record(state):
        journal['state'] = state
        journal.setdefault('events', []).append({'at':now(),'state':state})
        save(journal_path, journal)
    def stopped():
        try:
            check_stopped()
        except BaseException as error:
            journal.setdefault('stoppedRefusal', {'at':now(),'kind':getattr(error,'kind','stopped-state-unknown'),
                                                'reason':str(error),'transactionState':journal['state']})
            record('stopped-check-refused')
            raise
    def rename(source, target, label):
        require(not target.exists() and not target.is_symlink(), 'Rename target already exists: ' + str(target))
        record('before-' + label)
        os.rename(source, target)
        sync_dir(source.parent)
        if target.parent != source.parent:
            sync_dir(target.parent)
        record('after-' + label)
    try:
        stopped(); check_data()
        require(manifest(app) == before and manifest(candidate) == expected, 'Pre-rename bundle changed.')
        rename(app, old, 'old-bundle-rename')
        stopped(); check_data()
        require(manifest(old) == before and manifest(candidate) == expected, 'Bundle changed between renames.')
        rename(candidate, app, 'candidate-rename')
        require(manifest(app) == expected and manifest(old) == before, 'Post-rename bundle changed.')
        postcheck()
        check_data(); stopped()
        record('verified-build40-installed')
    except BaseException as error:
        journal['error'] = type(error).__name__ + ': ' + str(error)
        record('postcheck-failed')
        try:
            # Independent fresh checks are mandatory even when check_data caused the original failure.
            stopped(); check_data()
            require(journal.get('launched') is False, 'A successor launch forbids automatic downgrade.')
            require('stoppedRefusal' not in journal, 'Automatic downgrade forbidden after an observed writer or uncertain stopped state.')
            if old.exists():
                require(not old.is_symlink() and manifest(old) == before, 'Exact original rollback bundle is unavailable.')
                if app.exists() or app.is_symlink():
                    require(not app.is_symlink() and manifest(app) == expected, 'Current successor bundle is unknown; preserve both bundles.')
                    rename(app, old.parent / 'Build40-postcheck-failed.app', 'failed-candidate-rename')
                stopped(); check_data()
                require(manifest(old) == before, 'Old bundle changed immediately before restoration.')
                rename(old, app, 'old-bundle-restoration')
            require(manifest(app) == before, 'Baseline restoration differs.')
            check_data(); stopped()
            record('rolled-back-to-original-build')
        except BaseException as rollback_error:
            journal['rollbackError'] = type(rollback_error).__name__ + ': ' + str(rollback_error)
            record('recovery-required-preserve-bundles-and-current-data')
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-approved-build40', action='store_true')
    parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    require(args.install_approved_build40 and sha(BASE / 'source-manifest.json') == args.manifest_sha256,
            'Explicit install approval for the reviewed frozen manifest is required.')
    require(not (BASE / 'installation.json').exists(), 'Prior installation receipt exists.')
    journal_path = BASE / 'installation-journal.json'
    journal = {'startedAt':now(),'installedApp':str(APP),'build':'40','launched':False,'state':'attempt-started','events':[]}
    begin_attempt(journal_path, journal)
    source, baseline = load_inputs(); require_gates(source)
    package = json.loads((BASE / 'candidate-receipt.json').read_bytes())
    signing = source['inputs']['signing']
    require(package['build'] == '40' and package['baselineBuild'] == baseline['installedBuild']
            and package['sourceManifestSHA256'] == args.manifest_sha256 and package['baselineSHA256'] == source['inputs']['baseline']['sha256']
            and package['candidateBundleManifestSHA256'] == sha(BASE / 'candidate-bundle-manifest.json')
            and package['signatureVerified'] is True and package['sameDesignatedRequirement'] is True
            and package['signingIdentity'] == signing['identity'] and package['designatedRequirement'] == signing['designatedRequirement'],
            'Package identity, evidence or signing receipt differs.')
    expected = json.loads((BASE / 'candidate-bundle-manifest.json').read_bytes())
    require(package['bundleDelta'] == delta(baseline['bundleManifest'], expected)
            and package['resourceDelta'] == delta(resources_view(baseline['bundleManifest']),resources_view(expected))
            and package['resourceDelta'] == source['approvedResourceDelta']
            and expected['Contents/MacOS/QwenLocal']['sha256'] == package['binarySHA256'], 'Package delta or native pin differs.')
    archive = Path(package['archive'])
    require(archive == BASE / 'outputs/Saleh-Uncensored-Build40.zip' and not archive.is_symlink() and sha(archive) == package['archiveSHA256'], 'Archive changed.')
    require_stopped(); verify_data(baseline); verify_installed(source, baseline)
    model_before = observe_model_listener()
    nonce = uuid.uuid4().hex
    stage = APP.parent / ('.saleh-build40-update-' + nonce); stage.mkdir(mode=0o700)
    journal.update(stage=str(stage)); save(journal_path, journal)
    subprocess.run(['/usr/bin/ditto','-x','-k',str(archive),str(stage)], check=True)
    candidate = stage / APP.name
    require(not candidate.is_symlink() and manifest(candidate) == expected, 'Extracted full bundle differs.')
    require(requirement(candidate) == signing['designatedRequirement'], 'Extracted signature differs.')
    verify_candidate(candidate, source, baseline, package['generatedEntries'])
    verify_proof(candidate, source, baseline, package['proof'])
    backup_parent = SUPPORT / 'Saleh Uncensored Backups'
    require(not backup_parent.is_symlink(), 'Backup parent is a symlink.')
    backup_parent.mkdir(mode=0o700, exist_ok=True)
    require(backup_parent.resolve(strict=True) == backup_parent, 'Backup path is not canonical.')
    backup = backup_parent / ('before-Build40-' + nonce); backup.mkdir(mode=0o700)
    backups = {}
    for name,original in DATA_ROOTS.items():
        require_stopped(); verify_data(baseline)
        expected_data = baseline['dataManifests'][name]
        backups[name] = {'source':str(original),'present':expected_data is not None}
        if expected_data is not None:
            destination = backup / name
            subprocess.run(['/usr/bin/ditto',str(original),str(destination)], check=True)
            require(manifest(destination, True) == expected_data, 'Data backup differs: ' + name)
            verify_data(baseline)
            backups[name]['copy'] = str(destination)
    save(backup / 'data-manifests.json', baseline['dataManifests'])
    save(backup / 'backup-receipt.json', {'createdAt':now(),'dataIdentities':baseline['dataIdentities'],'backups':backups})
    old = stage / ('Build' + baseline['installedBuild'] + '-original.app')
    journal.update(rollbackApp=str(old),dataBackup=str(backup),state='prepared')
    save(journal_path, journal)
    def check_data():
        verify_data(baseline)
        verify_assets(source)
        verify_evidence(source['inputs'], read_ref(source['inputs']['sourceIntegration']))
    def postcheck():
        require(requirement(APP) == signing['designatedRequirement'], 'Installed signature differs.')
        verify_proof(APP, source, baseline, package['proof'])
    require_stopped(); check_data(); verify_installed(source, baseline)
    replace_bundle(APP, candidate, old, baseline['bundleManifest'], expected, journal_path, journal, check_data, require_stopped, postcheck)
    result = {'installedAt':now(),'installedApp':str(APP),'version':'1.3','build':'40','binarySHA256':sha(APP / 'Contents/MacOS/QwenLocal'),
              'archiveSHA256':package['archiveSHA256'],'bundleMatchesVerifiedPackage':True,'signatureVerified':True,
              'sameDesignatedRequirement':True,'rollbackApp':str(old),'rollbackMatchesFreshBaseline':True,
              'dataBackup':str(backup),'backups':backups,'resourceDelta':package['resourceDelta'],'proof':package['proof'],
              'baselineSHA256':source['inputs']['baseline']['sha256'],'dataUnchanged':True,'originalDirectoryIdentitiesUnchanged':True,
              'originalDataReplaced':False,'launched':False,'securitySettingsChanged':False,'vmTouched':False,
              'standaloneModelListenerBefore':model_before,'standaloneModelListenerAfter':observe_model_listener(),'standaloneModelTouched':False,
              'actualRebootAcceptance':'pending','productionHistoryAcceptance':'pending'}
    require(result['binarySHA256'] == package['binarySHA256'], 'Installed binary changed.')
    save(BASE / 'installation.json', result)
    print(json.dumps({key:value for key,value in result.items() if key != 'backups'}, indent=2))


if __name__ == '__main__':
    main()
