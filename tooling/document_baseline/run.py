#!/usr/bin/env python3
"""No network, private input, app invocation, package install, or model use."""
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(command, directory, name, timeout=15):
    """Own process group; deadline applies to direct process and descendants."""
    start = time.monotonic()
    out, err = directory / (name + '.stdout'), directory / (name + '.stderr')
    with out.open('xb') as stdout, err.open('xb') as stderr:
        process = subprocess.Popen(command, stdout=stdout, stderr=stderr,
                                   start_new_session=True, env={
                                       'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
                                       'HOME': str(directory), 'TMPDIR': str(directory)})
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise TimeoutError(name)
    # This is a post-run evidence cap, not a hard write quota or memory sandbox.
    if out.stat().st_size + err.stat().st_size > 1_048_576:
        raise RuntimeError('Unexpected evidence size')
    return {'command': command, 'exit_code': code,
            'elapsed_seconds': time.monotonic() - start,
            'stdout_sha256': digest(out), 'stderr_sha256': digest(err)}, out


def assess(extractions):
    text = lambda name: '\n'.join(page['text'] for page in extractions[name]['pages'])
    memo = text('text')
    table = text('table')
    columns = text('columns')
    return {
        'memo_all_expected_lines': all(value in memo for value in (
            'Synthetic research memo', 'Project Cedar ships on 14 November 2026.',
            'Budget: 4200 credits. Owner: Ada Example.')),
        'table_all_expected_row_text': all(value in table for value in (
            'Item Quantity Cost', 'Pencils 12 24', 'Folders 3 18')),
        'columns_column_major': columns == 'LEFT FIRST\nLEFT SECOND\nRIGHT FIRST\nRIGHT SECOND',
        'image_only_text_empty': text('image') == '',
        'blank_text_empty': text('blank') == '',
        'semantic_table_structure_available': False,
        'ocr_performed': False,
    }


def main():
    artifacts = ROOT / '.artifacts'
    artifacts.mkdir(exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='native-document-baseline-', dir=artifacts))
    receipt = {'schema_version': 1, 'scope': 'five authored single-page PDF fixtures only',
               'os': platform.platform(), 'source_hashes': {
                   path.name: digest(path) for path in HERE.iterdir() if path.suffix in ('.py', '.swift')},
               'steps': [], 'status': 'incomplete', 'app_capability_enabled': False,
               'limitations': ['No OCR or model inference', 'No memory sandbox or hard disk quota',
                               'No arbitrary/untrusted input qualification',
                               'Single run timings, not performance distribution',
                               'No Office conversion', 'No representative held-out corpus']}
    try:
        receipt['git_commit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        receipt['git_status'] = subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True)
        compiler = subprocess.check_output(['/usr/bin/xcrun', '--find', 'swiftc'], text=True).strip()
        receipt['compiler_sha256'] = digest(compiler)
        sdk = subprocess.check_output(['/usr/bin/xcrun', '--sdk', 'macosx', '--show-sdk-path'], text=True).strip()
        receipt['sdk_path'] = sdk
        step, _ = run([compiler, '-sdk', sdk, '-target', 'arm64-apple-macosx14.0', '-module-cache-path', str(directory / 'module-cache'), str(HERE / 'pdfkit_baseline.swift'), '-o', str(directory / 'baseline')], directory, 'compile', 120)
        receipt['steps'].append(step)
        if step['exit_code']: raise RuntimeError('Compilation failed')
        receipt['binary_sha256'] = digest(directory / 'baseline')
        step, _ = run([str(directory / 'baseline'), 'generate', str(directory)], directory, 'generate')
        receipt['steps'].append(step)
        if step['exit_code']: raise RuntimeError('Fixture generation failed')
        extractions = {}
        receipt['fixture_hashes'] = {}
        for name in ('text', 'table', 'columns', 'image', 'blank'):
            fixture = directory / (name + '.pdf')
            receipt['fixture_hashes'][name] = digest(fixture)
            step, output = run([str(directory / 'baseline'), 'extract', str(fixture)], directory, name)
            receipt['steps'].append(step)
            if step['exit_code']: raise RuntimeError('Extraction failed: ' + name)
            extractions[name] = json.loads(output.read_text())
            if extractions[name]['page_count'] != 1: raise RuntimeError('Unexpected page count')
        receipt['observations'] = assess(extractions)
        receipt['extractions'] = extractions
        for name, content in [('invalid', b'not a PDF'), ('oversized', b'0' * 1_048_577)]:
            fixture = directory / (name + '.pdf')
            fixture.write_bytes(content)
            step, output = run([str(directory / 'baseline'), 'extract', str(fixture)], directory, name)
            receipt['steps'].append(step)
            expected = b'Invalid PDF' if name == 'invalid' else b'Input exceeds 1 MiB'
            if step['exit_code'] != 2 or expected not in (directory / (name + '.stderr')).read_bytes() or output.stat().st_size:
                raise RuntimeError('Negative fixture was not rejected: ' + name)
        receipt['negative_inputs_rejected'] = 2
        # Complete means measured, not all content/ordering capabilities successful.
        receipt['status'] = 'measured'
    except Exception as error:
        receipt['error'] = str(error)
        receipt['status'] = 'failed'
    finally:
        (directory / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(directory / 'receipt.json')
    return 0 if receipt['status'] == 'measured' else 1


if __name__ == '__main__':
    raise SystemExit(main())
