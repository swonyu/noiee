"""Approved-trial staging only: fixed-plan official wheels, no imports/install."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
import threading
import time
import urllib.parse
import urllib.request

LIMIT = 80 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Wheel redirects are not accepted')


def verify_package(row):
    parsed = urllib.parse.urlsplit(row['wheel_url'])
    if parsed.scheme != 'https' or parsed.hostname != 'files.pythonhosted.org' or parsed.query or parsed.fragment or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Expected official HTTPS wheel URL')
    if Path(row['filename']).name != row['filename'] or not row['filename'].endswith('.whl') or Path(parsed.path).name != row['filename']:
        raise ValueError('Unsafe/mismatched wheel filename')
    if type(row['bytes']) is not int or row['bytes'] <= 0 or row['bytes'] > LIMIT:
        raise ValueError('Invalid wheel size')
    if len(row['sha256']) != 64 or any(c not in '0123456789abcdef' for c in row['sha256']):
        raise ValueError('Invalid hash')


def stage(plan_path, wheelhouse, *, opener=None):
    plan = json.loads(Path(plan_path).read_text())
    rows = plan['packages']
    if len(rows) != 51 or sum(r['bytes'] for r in rows) != 70944225:
        raise ValueError('Not the reviewed 51-wheel plan')
    if len({r['filename'] for r in rows}) != len(rows):
        raise ValueError('Duplicate wheel filename')
    for row in rows:
        verify_package(row)
    wheelhouse = Path(wheelhouse)
    wheelhouse.mkdir(mode=0o700)
    start = time.monotonic()
    lock = threading.Lock()
    cancelled = threading.Event()
    received = 0
    open_url = opener or urllib.request.build_opener(NoRedirect()).open

    def download(row):
        nonlocal received
        if cancelled.is_set():
            raise RuntimeError('Stage cancelled')
        remaining = 120 - (time.monotonic() - start)
        if remaining <= 0:
            raise TimeoutError('Stage deadline')
        digest = hashlib.sha256()
        count = 0
        target = wheelhouse / row['filename']
        partial = target.with_suffix('.partial')
        try:
            req = urllib.request.Request(row['wheel_url'], headers={'Accept-Encoding': 'identity'})
            with open_url(req, timeout=min(5, remaining)) as response:
                if response.status != 200 or response.geturl() != row['wheel_url']:
                    raise ValueError('Unexpected wheel response/redirect')
                if response.headers.get('Content-Encoding', 'identity') != 'identity' or int(response.headers.get('Content-Length', '-1')) != row['bytes']:
                    raise ValueError('Unexpected wheel response size/encoding')
                with partial.open('xb') as output:
                    while True:
                        if cancelled.is_set() or time.monotonic() - start >= 120:
                            raise TimeoutError('Stage cancelled/deadline')
                        chunk = response.read(min(65536, row['bytes'] - count + 1))
                        if not chunk:
                            break
                        with lock:
                            received += len(chunk)
                            if received > LIMIT:
                                raise ValueError('80MiB cumulative transfer cap')
                        count += len(chunk)
                        if count > row['bytes']:
                            raise ValueError('Oversized wheel body')
                        digest.update(chunk)
                        output.write(chunk)
            if count != row['bytes'] or digest.hexdigest() != row['sha256']:
                raise ValueError('Wheel hash/size mismatch')
            partial.rename(target)
            return {'name': row['name'], 'version': row['version'], 'bytes': count,
                    'sha256': digest.hexdigest(), 'filename': row['filename'], 'verified': True}
        except Exception:
            cancelled.set()
            raise

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(download, rows))
    return {'status': 'verified', 'received_bytes': received,
            'elapsed_seconds': round(time.monotonic() - start, 4), 'packages': results}


if __name__ == '__main__':
    print(json.dumps(stage(sys.argv[1], sys.argv[2]), indent=2))
