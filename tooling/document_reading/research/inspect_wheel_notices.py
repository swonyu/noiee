"""Opt-in metadata research, never wheel code execution or model-weight reading.
HTTPS official-PyPI wheel URLs only, including redirects. At most 20 MiB reserved
range bytes per run, 4 MiB per range and 1 MiB per decompressed notice/registry.
"""
import base64
import concurrent.futures
import hashlib
import io
import json
import sys
import threading
import urllib.parse
import urllib.request
import zipfile

MEMBER_LIMIT = 1024 * 1024


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'files.pythonhosted.org'
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.query or parsed.fragment or not parsed.path.endswith('.whl')):
        raise ValueError('Only HTTPS official PyPI wheel URLs')


class CheckedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)  # Reject before the redirect destination is contacted.
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_checked(request):
    validate_url(request.full_url)
    return urllib.request.build_opener(CheckedRedirect()).open(request, timeout=20)


class RemoteWheel(io.RawIOBase):
    transferred = 0  # Conservative reservation, including failed range requests.
    lock = threading.Lock()

    def __init__(self, url, opener=None):
        validate_url(url)
        self.url, self.pos = url, 0
        self.opener = opener or open_checked
        with self.opener(urllib.request.Request(url, method='HEAD')) as r:
            validate_url(r.geturl())
            if r.status != 200:
                raise ValueError('Unexpected HEAD status')
            self.size = int(r.headers['Content-Length'])
            if self.size <= 0:
                raise ValueError('Invalid wheel size')

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        if whence not in (0, 1, 2):
            raise ValueError('Invalid seek mode')
        pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        if pos < 0:
            raise ValueError('Negative seek')
        self.pos = pos
        return self.pos

    def tell(self):
        return self.pos

    def read(self, size=-1):
        size = min(self.size - self.pos, size if size >= 0 else self.size - self.pos)
        if size <= 0:
            return b''
        with RemoteWheel.lock:
            if size > 4 * MEMBER_LIMIT or RemoteWheel.transferred + size > 20 * MEMBER_LIMIT:
                raise ValueError('Research transfer budget exceeded')
            RemoteWheel.transferred += size
        end = self.pos + size - 1
        req = urllib.request.Request(self.url, headers={
            'Range': f'bytes={self.pos}-{end}', 'Accept-Encoding': 'identity'})
        with self.opener(req) as r:
            validate_url(r.geturl())
            if r.status != 206:
                raise ValueError('Server did not honor Range')
            if r.headers.get('Content-Range') != f'bytes {self.pos}-{end}/{self.size}':
                raise ValueError('Mismatched Content-Range')
            if r.headers.get('Content-Encoding', 'identity') != 'identity':
                raise ValueError('Encoded range response')
            if int(r.headers.get('Content-Length', '-1')) != size:
                raise ValueError('Mismatched Content-Length')
            data = r.read(size + 1)
        if len(data) != size:
            raise ValueError('Unexpected range length')
        self.pos += len(data)
        return data


def read_member(archive, member):
    info = archive.getinfo(member) if isinstance(member, str) else member
    if info.file_size > MEMBER_LIMIT or info.file_size < 0:
        raise ValueError('Member exceeds 1MiB cap')
    with archive.open(info) as stream:
        data = stream.read(MEMBER_LIMIT + 1)
    if len(data) > MEMBER_LIMIT or len(data) != info.file_size:
        raise ValueError('Invalid decompressed member size')
    return data


def notice_record(data):
    try:
        text = data.decode('utf8')
        decoding = 'utf-8-strict'
    except UnicodeDecodeError:
        text = data.decode('utf8', errors='replace')
        decoding = 'utf-8-replacement-lossy-preview'
    return {'sha256': hashlib.sha256(data).hexdigest(),
            'raw_base64': base64.b64encode(data).decode('ascii'),
            'text': text, 'text_decoding': decoding}


def inspect(item):
    m = item['metadata']
    row = {'name': m['name'], 'version': m['version'],
           'wheel_url': item['download_info']['url'], 'notices': []}
    try:
        with zipfile.ZipFile(RemoteWheel(row['wheel_url'])) as z:
            row['wheel_entries'] = len(z.infolist())
            candidates = [i for i in z.infolist() if not i.is_dir() and any(
                s in i.filename.lower() for s in ['license', 'licence', 'copying', 'notice', 'copyright'])]
            for info in candidates:
                n = {'path': info.filename, 'size': info.file_size}
                if info.file_size > MEMBER_LIMIT:
                    n['status'] = 'skipped: notice exceeds 1MiB cap'
                else:
                    n.update(status='read', **notice_record(read_member(z, info)))
                row['notices'].append(n)
            if m['name'].lower() == 'rapidocr':
                data = read_member(z, 'rapidocr/default_models.yaml')
                row['registry_sha256'] = hashlib.sha256(data).hexdigest()
                row['registry_text'] = data.decode('utf8')
    except Exception as exc:
        row['error'] = str(exc)
    print(m['name'], len(row['notices']), row.get('error', ''), flush=True)
    return row


def main():
    with open(sys.argv[1]) as file:
        report = json.load(file)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(inspect, report['install']))
    with open(sys.argv[2], 'w') as file:
        json.dump({'reserved_range_bytes': RemoteWheel.transferred, 'artifacts': rows}, file, indent=2)


if __name__ == '__main__':
    main()
