"""Explicit scoped trial; never invoked by application/ordinary test discovery.
Stages the reviewed official wheels, creates its own venv, verifies sandbox
network denial, then probes real Docling imports. Stops on any failure.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from bounded_process import Bounds, run_bounded

PYTHON = '/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/bin/python3.14'
ROOT = Path(__file__).resolve().parents[1]
SANDBOX = ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)']


def main(baseline_dir):
    artifacts = ROOT.parents[1] / '.artifacts'
    artifacts.mkdir(exist_ok=True)
    job = Path(tempfile.mkdtemp(prefix='docling-native-trial-', dir=artifacts))
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(job/'home'), 'TMPDIR': str(job/'tmp'),
           'PYTHONDONTWRITEBYTECODE': '1', 'PIP_CONFIG_FILE': '/dev/null',
           'PIP_DISABLE_PIP_VERSION_CHECK': '1', 'OMP_NUM_THREADS': '2',
           'OPENBLAS_NUM_THREADS': '2', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
           'XDG_CACHE_HOME': str(job/'cache')}
    for name in ['home', 'tmp', 'cache', 'fixtures']:
        (job/name).mkdir()
    receipt = {'scope': 'approved isolated model-free synthetic trial', 'steps': [],
               'fixture_hashes': {}, 'conversion_executed': False}
    baseline = json.loads((baseline_dir/'receipt.json').read_text())
    for name, expected in baseline['fixture_hashes'].items():
        if name not in ('text', 'table', 'columns', 'image', 'blank'):
            raise ValueError('Unexpected baseline fixture')
        source = baseline_dir/f'{name}.pdf'
        data = source.read_bytes()
        if len(data) > 1024*1024 or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError('Baseline fixture identity/size mismatch')
        (job/'fixtures'/source.name).write_bytes(data)
        receipt['fixture_hashes'][name] = expected
    receipt['baseline_extractions'] = baseline['extractions']
    for name in ['trial_stage.py', 'trial_child.py']:
        shutil.copyfile(ROOT/'research'/name, job/name)
    shutil.copyfile(ROOT/'runtime_plan/minimal-wheel-plan.json', job/'wheel-plan.json')
    shutil.copyfile(ROOT/'runtime_plan/requirements-native.lock', job/'requirements.lock')
    stop = threading.Event()
    disk_exceeded = threading.Event()
    peak_disk = [0]

    def watch_disk():
        while not stop.is_set():
            try:
                size = 0
                for path in job.rglob('*'):
                    try:
                        if path.is_file() and not path.is_symlink():
                            size += path.stat().st_size
                    except FileNotFoundError:
                        continue
            except Exception:
                disk_exceeded.set()  # Fail closed if monitoring is unavailable.
                return
            peak_disk[0] = max(peak_disk[0], size)
            if size > 1024*1024*1024:
                disk_exceeded.set()
            stop.wait(.1)

    thread = threading.Thread(target=watch_disk, daemon=True)
    thread.start()

    def step(name, argv, seconds=60):
        result = run_bounded(argv, cwd=job, env=env, bounds=Bounds(wall_seconds=seconds), cancel=disk_exceeded)
        raw = result.pop('output')
        (job/f'{name}.output').write_bytes(raw)
        result.update(name=name, output_sha256=hashlib.sha256(raw).hexdigest(), output_bytes=len(raw))
        receipt['steps'].append(result)
        (job/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
        print(json.dumps(result), flush=True)
        return result['status'] == 'complete'

    try:
        if not step('stage', [PYTHON, '-I', str(job/'trial_stage.py'), str(job/'wheel-plan.json'), str(job/'wheels')], 120):
            return
        if not step('venv', [PYTHON, '-I', '-m', 'venv', str(job/'venv')], 120):
            return
        python = str(job/'venv/bin/python')
        if not step('install', SANDBOX+[python, '-I', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'install', '--no-index', '--no-deps', '--require-hashes', '--only-binary=:all:', '--no-compile', '--find-links', str(job/'wheels'), '-r', str(job/'requirements.lock')], 120):
            return
        if not step('network-probe', SANDBOX+[python, '-I', str(job/'trial_child.py'), 'network-probe']):
            return
        step('import-probe', SANDBOX+[python, '-I', str(job/'trial_child.py'), 'import-probe'])
    finally:
        stop.set()
        thread.join(timeout=2)
        receipt['peak_sampled_scratch_bytes'] = peak_disk[0]
        receipt['disk_limit_exceeded'] = disk_exceeded.is_set()
        (job/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
        print('JOB_DIRECTORY='+str(job), flush=True)


if __name__ == '__main__':
    main(Path(sys.argv[1]))
