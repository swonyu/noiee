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

ROOT = Path(__file__).resolve().parents[3]
CHECKS = [
    ('grader_controls', ['tool_selection','arguments','grounding','memory','cancellation_reasoning'],
     'python', ['-m','unittest','discover','-s','tooling/model_lab/bench','-p','test_*.py']),
    ('stream_stop', ['cancellation'], 'node', ['--test','source/agent-cancel-check.mjs']),
    ('agent_lifecycle', ['arguments','grounding','memory','cancellation'], 'node', ['source/agent-runs-check.mjs']),
    ('agent_budget', ['grounding','memory','cancellation'], 'node', ['source/agent-budget-check.mjs']),
    ('saved_drafts', ['memory'], 'node', ['--test','source/chat-draft-save-check.mjs']),
    ('stop_outcomes', ['grounding','cancellation'], 'node', ['--test','source/coding-mcp-stop-check.mjs']),
    ('live_profile_guards', ['memory','grounding'], 'node', ['--test','tooling/live-profile-check.mjs']),
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
    report={'version':1,'evidence_kind':'offline_synthetic_integration_and_grader_controls',
            'model_evaluated':False,'model_score':None,
            'scope':'No app UI, native server, loaded model, MCP process, or user data tested.',
            'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'source_sha256':before,'checks':[],'status':'running'}
    def save():
        (out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    save()
    for name,categories,runtime,arguments in CHECKS:
        executable=sys.executable if runtime=='python' else args.node
        command=[executable,*arguments] if executable else []
        start=time.monotonic()
        row={'id':name,'categories':categories,'command':command,'cwd':str(ROOT)}
        log=out/(name+'.log')
        try:
            if not executable: raise FileNotFoundError('Node runtime unavailable')
            with log.open('wb') as handle:
                result=subprocess.run(command,cwd=ROOT,stdout=handle,stderr=subprocess.STDOUT,timeout=120,check=False)
            row.update(status='pass' if result.returncode==0 else 'fail',exit_code=result.returncode)
        except (OSError,subprocess.TimeoutExpired) as exc:
            row.update(status='blocked' if isinstance(exc,OSError) else 'timeout',error=str(exc))
        row.update(elapsed_seconds=round(time.monotonic()-start,3),log=log.name,
                   log_sha256=hashlib.sha256(log.read_bytes()).hexdigest() if log.exists() else None)
        report['checks'].append(row);save()
        print(json.dumps(row),flush=True)
    report['source_unchanged']=before==pins()
    report['passed_checks']=sum(c['status']=='pass' for c in report['checks'])
    report['selected_checks']=len(CHECKS)
    report['status']='pass' if report['passed_checks']==len(CHECKS) and report['source_unchanged'] else 'fail'
    report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
    print(json.dumps({'status':report['status'],'passed_checks':report['passed_checks'],'selected_checks':len(CHECKS),'receipt':str(out/'results.json')}))
    return 0 if report['status']=='pass' else 1


if __name__=='__main__': raise SystemExit(main())
