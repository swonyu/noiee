#!/usr/bin/env python3
"""Offline synthetic evaluation receipt. No server, model, app UI or user data.

Executes a fixed allowlist of checked-in tests, never model-generated commands.
Each suite's stdout/stderr, exit status, timing and source hashes are retained.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from offline_receipts import (EvidenceError, clean_environment, identify_runtime,
                              executable_pin, validate_completion, verify_log, sha, COUNTS, MARKERS)

ROOT = Path(__file__).resolve().parents[3]
CHECKS = [
    ('grader_controls', ['tool_selection','arguments','grounding','memory','cancellation_reasoning'],
     'python', ['-m','unittest','discover','-s','tooling/model_lab/bench','-p','test_*.py']),
    ('stream_stop', ['cancellation'], 'node', ['--test','--test-reporter=tap','source/agent-cancel-check.mjs']),
    ('agent_lifecycle', ['arguments','grounding','memory','cancellation'], 'node', ['source/agent-runs-check.mjs']),
    ('agent_budget', ['grounding','memory','cancellation'], 'node', ['source/agent-budget-check.mjs']),
    ('saved_drafts', ['memory'], 'node', ['--test','--test-reporter=tap','source/chat-draft-save-check.mjs']),
    ('stop_outcomes', ['grounding','cancellation'], 'node', ['--test','--test-reporter=tap','source/coding-mcp-stop-check.mjs']),
    ('live_profile_guards', ['memory','grounding'], 'node', ['--test','--test-reporter=tap','tooling/live-profile-check.mjs']),
]


def pins():
    # Include transitive local modules and configuration, not dependencies/artifacts.
    paths=subprocess.check_output(['git','ls-files','-z','source','tooling','checks'],cwd=ROOT).decode().split('\0')
    paths += [str(p.relative_to(ROOT)) for p in Path(__file__).parent.glob('*.py')]
    return {p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in sorted(set(paths))
            if p and (ROOT/p).is_file()}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',required=True)
    parser.add_argument('--node',default=shutil.which('node'))
    args=parser.parse_args(argv)
    os.umask(0o077)
    out=Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True,exist_ok=True)
    if any(out.iterdir()): parser.error('use a new empty directory; existing evidence is never overwritten')
    before=pins()
    environment=clean_environment()
    report={'version':2,'evidence_kind':'offline_synthetic_integration_and_grader_controls',
            'model_evaluated':False,'model_score':None,
            'scope':'No app UI, native server, loaded model, MCP process, or user data tested.',
            'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'source_sha256':before,'checks':[],'status':'running',
            'environment':environment,'runtimes':{}}
    def save():
        (out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    save()
    try:
        for kind,executable in [('python',sys.executable),('node',args.node)]:
            if not executable: raise EvidenceError('Node runtime unavailable')
            report['runtimes'][kind]=identify_runtime(executable,kind,environment)
    except (OSError,ValueError,subprocess.TimeoutExpired) as exc:
        report.update(status='blocked',error=str(exc),passed_checks=0,selected_checks=len(CHECKS))
        save();print(json.dumps({'status':'blocked','error':str(exc),'receipt':str(out/'results.json')}));return 1
    save()
    for name,categories,runtime,arguments in CHECKS:
        identity=report['runtimes'][runtime]
        executable=identity['path']
        flags=['-I','-S'] if runtime=='python' else ['--no-addons','--no-global-search-paths']
        command=[executable,*flags,*arguments]
        start=time.monotonic()
        row={'id':name,'categories':categories,'command':command,'cwd':str(ROOT),
             'runtime_sha256':identity['sha256'],
             'input_sha256':({str(p.relative_to(ROOT)):sha(p) for p in Path(__file__).parent.glob('test_*.py')} if runtime=='python' else {arg:sha(ROOT/arg) for arg in arguments if (ROOT/arg).is_file()})}
        log=out/(name+'.log')
        try:
            if executable_pin(executable)!={k:identity[k] for k in ['path','sha256']}:
                raise EvidenceError('runtime changed before execution')
            with log.open('wb') as handle:
                result=subprocess.run(command,cwd=ROOT,stdout=handle,stderr=subprocess.STDOUT,timeout=120,check=False,env=environment)
            row['exit_code']=result.returncode
            if result.returncode!=0: raise EvidenceError('test process returned nonzero exit')
            row['completion']=validate_completion(name,log.read_text())
            if executable_pin(executable)!={k:identity[k] for k in ['path','sha256']}:
                raise EvidenceError('runtime changed during execution')
            row['status']='pass'
        except (OSError,EvidenceError,subprocess.TimeoutExpired) as exc:
            row.update(status='timeout' if isinstance(exc,subprocess.TimeoutExpired) else 'fail',error=str(exc))
        row.update(elapsed_seconds=round(time.monotonic()-start,3),log=log.name,
                   log_sha256=hashlib.sha256(log.read_bytes()).hexdigest() if log.exists() else None)
        report['checks'].append(row);save()
        print(json.dumps(row),flush=True)
    report['source_unchanged']=before==pins()
    try:
        report['runtimes_unchanged']=all(executable_pin(r['path'])=={k:r[k] for k in ['path','sha256']} for r in report['runtimes'].values())
    except OSError:
        report['runtimes_unchanged']=False
    for row in report['checks']:
        if row['status']=='pass':
            try: verify_log(out/row['log'],row['log_sha256'],row['id'])
            except (OSError,EvidenceError) as exc: row.update(status='fail',error=str(exc))
    report['execution_complete']=(len(report['checks'])==len(COUNTS)+len(MARKERS) and
                                  {r['id'] for r in report['checks']}==set(COUNTS)|set(MARKERS))
    report['passed_checks']=sum(c['status']=='pass' for c in report['checks'])
    report['selected_checks']=len(CHECKS)
    report['status']='pass' if report['passed_checks']==len(CHECKS) and report['source_unchanged'] and report['runtimes_unchanged'] and report['execution_complete'] else 'fail'
    report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
    print(json.dumps({'status':report['status'],'passed_checks':report['passed_checks'],'selected_checks':len(CHECKS),'receipt':str(out/'results.json')}))
    return 0 if report['status']=='pass' else 1


if __name__=='__main__': raise SystemExit(main())
