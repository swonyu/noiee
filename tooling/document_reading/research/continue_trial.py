"""Continue only a successfully staged/imported owned job. No downloads/install."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import threading
from bounded_process import Bounds, run_bounded
from run_trial import ROOT, SANDBOX


def main(job):
    job = job.resolve()
    expected_parent = ROOT.parents[1] / '.artifacts'
    if job.parent != expected_parent.resolve() or not job.name.startswith('docling-native-trial-'):
        raise ValueError('Not an owned trial directory')
    receipt = json.loads((job/'receipt.json').read_text())
    for required in ['stage', 'venv', 'install', 'network-probe', 'import-probe']:
        if not any(s['name'] == required and s['status'] == 'complete' for s in receipt['steps']):
            raise ValueError('Prior gate not complete: '+required)
    for name, digest in receipt['fixture_hashes'].items():
        if hashlib.sha256((job/'fixtures'/f'{name}.pdf').read_bytes()).hexdigest() != digest:
            raise ValueError('Copied PDF fixture changed')
    shutil.copyfile(ROOT/'research/trial_child.py', job/'trial_child.py')
    receipt['conversion_child_sha256'] = hashlib.sha256((job/'trial_child.py').read_bytes()).hexdigest()
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(job/'home'), 'TMPDIR': str(job/'tmp'),
           'PYTHONDONTWRITEBYTECODE': '1', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2',
           'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'XDG_CACHE_HOME': str(job/'cache')}
    stop, disk_stop = threading.Event(), threading.Event()
    peak_disk = [receipt['peak_sampled_scratch_bytes']]

    def watch():
        while not stop.is_set():
            try:
                size = 0
                for path in job.rglob('*'):
                    try:
                        if path.is_file() and not path.is_symlink():
                            size += path.stat().st_size
                    except FileNotFoundError:
                        continue
                peak_disk[0] = max(peak_disk[0], size)
                if size > 1024*1024*1024:
                    disk_stop.set()
            except Exception:
                disk_stop.set()
            stop.wait(.1)

    monitor = threading.Thread(target=watch, daemon=True)
    monitor.start()

    def step(name, args):
        argv = SANDBOX+[str(job/'venv/bin/python'), '-I', str(job/'trial_child.py')]+args
        result = run_bounded(argv, cwd=job, env=env, bounds=Bounds(), cancel=disk_stop)
        raw = result.pop('output')
        (job/(name+'.output')).write_bytes(raw)
        result.update(name=name, output_sha256=hashlib.sha256(raw).hexdigest(), output_bytes=len(raw))
        receipt['steps'].append(result)
        (job/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
        print(json.dumps(result), flush=True)
        return result['status'] == 'complete'

    try:
        if not step('generate-office', ['generate-office']):
            return
        receipt['office_fixtures'] = json.loads((job/'fixtures/office-manifest.json').read_text())
        for name in ['text.pdf', 'table.pdf', 'columns.pdf', 'image.pdf', 'blank.pdf',
                     'synthetic.docx', 'synthetic.pptx', 'synthetic.xlsx']:
            receipt['conversion_executed'] = True
            if not step('convert-'+name, ['convert', name]):
                # No dependency widening or fallback parser after a failure.
                receipt['stopped_after'] = name
                break
    finally:
        stop.set()
        monitor.join(timeout=2)
        receipt['peak_sampled_scratch_bytes'] = peak_disk[0]
        receipt['disk_limit_exceeded'] = disk_stop.is_set()
        (job/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
        print('JOB_DIRECTORY='+str(job), flush=True)


if __name__ == '__main__':
    main(Path(sys.argv[1]))
