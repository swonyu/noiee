"""Fail-closed runtime and completed-test evidence for the offline Mac gate."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

# Reviewed local Homebrew Node, not a user-supplied self-report or --version string.
# Changing runtime requires explicit review and a new source-bound gate receipt.
NODE_RUNTIME = {'sha256':'7296c3dda88793e08d1089d839a782178c4bba6bb22f5c40ab2a75263fb071bd',
                'version':'v26.13.0','platform':'darwin','arch':'arm64'}
COUNTS = {'grader_controls':46,'stream_stop':7,'saved_drafts':10,
          'stop_outcomes':8,'live_profile_guards':26}
MARKERS = {
 'agent_lifecycle':[
  'PASS selected model on all 38 bounded plan/tool steps and tool-free final synthesis; exact claim at-most-once and durable result acknowledgement',
  'PASS stale review and revoked claimed effect refuse; known not-started completion drains selected Stop',
  'PASS Stop during claim save: zero effects, serialized completion and final durable receipt before Stop settles',
  'PASS cold pending Agent evidence is inspectable and never replays model or native work',
  'PASS native result save failure withholds acknowledgement and retains the durable claimed intent'],
 'agent_budget':[
  'PASS action 32, 64 computer receipts, saved-record reload and receipt 65 rejection',
  'PASS Chat/Coding policy order and fresh client/history reload retain all receipt fields',
  'PASS late Stop drains the exact claim and unknown effect never replays',
  'PASS context termination preserves receipts and requests one tool-free final review',
  'PASS final-review tool request performs zero additional effects']}


class EvidenceError(ValueError): pass


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def clean_environment():
    # No inherited NODE_OPTIONS/NODE_PATH, PYTHON*, DYLD_*, LD_* or shell hooks.
    return {'PATH':'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            'HOME':str(Path.home().resolve()), 'TMPDIR':'/tmp', 'LC_ALL':'C'}


def executable_pin(executable):
    path=Path(executable).resolve(strict=True)
    if not path.is_file() or not os.access(path,os.X_OK):
        raise EvidenceError('runtime is not an executable regular file')
    return {'path':str(path),'sha256':sha(path)}


def identify_runtime(executable, kind, environment):
    before=executable_pin(executable)
    if kind=='node':
        if before['sha256'] != NODE_RUNTIME['sha256']:
            raise EvidenceError('Node executable does not match the reviewed runtime SHA256')
        code='console.log(JSON.stringify({path:process.execPath,version:process.version,platform:process.platform,arch:process.arch,release:process.release.name}))'
        command=[before['path'],'--no-addons','--no-global-search-paths','-e',code]
    else:
        code='import json,sys; print(json.dumps({"path":sys.executable,"version":sys.version,"implementation":sys.implementation.name}))'
        command=[before['path'],'-I','-S','-c',code]
    result=subprocess.run(command,env=environment,capture_output=True,text=True,timeout=10,check=False)
    if result.returncode != 0 or result.stderr.strip():
        raise EvidenceError('runtime identity probe did not finish cleanly')
    try: identity=json.loads(result.stdout)
    except (ValueError,TypeError) as exc: raise EvidenceError('missing runtime identity JSON') from exc
    if not isinstance(identity,dict) or Path(identity.get('path','')).resolve()!=Path(before['path']):
        raise EvidenceError('runtime probe executable differs from invoked binary')
    if kind=='node' and (identity.get('release')!='node' or any(identity.get(k)!=NODE_RUNTIME[k] for k in ['version','platform','arch'])):
        raise EvidenceError('Node runtime identity mismatch')
    if kind=='python' and (identity.get('version')!=sys.version or identity.get('implementation')!=sys.implementation.name):
        raise EvidenceError('Python runtime identity mismatch')
    if executable_pin(executable)!=before: raise EvidenceError('runtime changed during identity probe')
    return {**before,'identity':identity,'probe_command':command}


def validate_completion(name, text):
    if not text.strip(): raise EvidenceError('empty test log')
    if name=='grader_controls':
        count=COUNTS[name]
        pattern=rf'\.{{{count}}}\n-+\nRan {count} tests in [0-9.]+s\n\nOK\n?'
        if not re.fullmatch(pattern,text): raise EvidenceError('Python completion/count mismatch, partial, skipped or duplicate evidence')
        return {'tests':count,'passed':count,'skipped':0,'failed':0}
    if name in COUNTS:
        count=COUNTS[name]
        if re.search(r'(?im)^\s*not ok\b|#\s*(skip|todo)\b(?! 0$)',text):
            raise EvidenceError('failed, skipped or todo test evidence')
        plans=re.findall(r'^1\.\.(\d+)$',text,re.M)
        oks=re.findall(r'^ok (\d+) - (.+)$',text,re.M)
        subtests=re.findall(r'^# Subtest: (.+)$',text,re.M)
        if plans!=[str(count)] or [int(n) for n,_ in oks]!=list(range(1,count+1)) or len(set(n for _,n in oks))!=count or subtests!=[n for _,n in oks]:
            raise EvidenceError('TAP plan, unique test identities or completed test count mismatch')
        for key,want in {'tests':count,'suites':0,'pass':count,'fail':0,'cancelled':0,'skipped':0,'todo':0}.items():
            if re.findall(rf'^# {key} (\d+)$',text,re.M)!=[str(want)]:
                raise EvidenceError('TAP summary mismatch: '+key)
        if len(re.findall(r'^TAP version 13$',text,re.M))!=1 or not re.search(r'^# duration_ms [0-9.]+\n?\Z',text,re.M):
            raise EvidenceError('missing or duplicate TAP completion envelope')
        return {'tests':count,'passed':count,'skipped':0,'failed':0}
    lines=text.splitlines()
    if [line for line in lines if line.startswith('PASS ')]!=MARKERS[name]:
        raise EvidenceError('missing, altered or duplicate lifecycle/budget marker')
    try: rows=[json.loads(line) for line in lines if not line.startswith('PASS ')]
    except ValueError as exc: raise EvidenceError('unexpected lifecycle log content') from exc
    expected_rows=2 if name=='agent_budget' else 1
    if len(rows)!=expected_rows or not lines[-1].startswith('{'):
        raise EvidenceError('missing or duplicate terminal lifecycle receipt')
    end=rows[-1]
    expected={'passed':True,'productionAppStarted':False,'nativeExecutionExercised':False}
    if name=='agent_budget': expected['realModelCalls']=0
    if set(end)!=set(expected)|{'fixtureRoot'} or any(type(end[k]) is not type(v) or end[k]!=v for k,v in expected.items()) or not isinstance(end['fixtureRoot'],str) or not end['fixtureRoot'].startswith('/'):
        raise EvidenceError('terminal lifecycle receipt mismatch')
    if name=='agent_budget' and rows[0]!={'requestedActions':13,'observedEffects':13,'modelRequests':14,'status':'complete','budgetReached':False,'receipts':13}:
        raise EvidenceError('initial budget execution evidence mismatch')
    return {'completed_markers':len(MARKERS[name]),'terminal_receipt':end}


def verify_log(path, digest, name):
    if sha(path)!=digest: raise EvidenceError('test log changed after execution')
    return validate_completion(name,Path(path).read_text())
