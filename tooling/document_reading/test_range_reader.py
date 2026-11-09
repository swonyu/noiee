"""Offline adversarial tests. No network, model, package or wheel execution."""
import base64
import hashlib
import io
import unittest
import urllib.request
import zipfile
from unittest.mock import Mock, patch
from research.inspect_wheel_notices import (
    CheckedRedirect, MEMBER_LIMIT, RemoteWheel, notice_record, read_member, validate_url,
)

URL = 'https://files.pythonhosted.org/packages/test.whl'


class Response(io.BytesIO):
    def __init__(self, data=b'', status=200, headers=None, url=URL):
        super().__init__(data)
        self.status, self.headers, self.url = status, headers or {}, url
        self.body_read = False

    def geturl(self):
        return self.url

    def read(self, size=-1):
        self.body_read = True
        return super().read(size)


class RangeTests(unittest.TestCase):
    def setUp(self):
        RemoteWheel.transferred = 0

    def make_reader(self, response):
        head = Response(headers={'Content-Length': '10'})
        return RemoteWheel(URL, opener=Mock(side_effect=[head, response]))

    def response(self, **overrides):
        args = dict(data=b'ab', status=206, headers={
            'Content-Length': '2', 'Content-Range': 'bytes 0-1/10'})
        args.update(overrides)
        return Response(**args)

    def test_exact_range(self):
        reader = self.make_reader(self.response())
        self.assertEqual(reader.read(2), b'ab')
        self.assertEqual(reader.tell(), 2)

    def test_range_mismatch_rejected_before_body(self):
        for value in [None, 'bytes 1-2/10', 'bytes 0-1/11', 'bytes 0-2/10',
                      'bytes */10', 'garbage']:
            response = self.response(headers={'Content-Length': '2', 'Content-Range': value})
            reader = self.make_reader(response)
            with self.assertRaisesRegex(ValueError, 'Content-Range'):
                reader.read(2)
            self.assertFalse(response.body_read)
            self.assertEqual(reader.tell(), 0)

    def test_non_range_status(self):
        response = self.response(status=200)
        with self.assertRaisesRegex(ValueError, 'honor Range'):
            self.make_reader(response).read(2)
        self.assertFalse(response.body_read)

    def test_wrong_length_header(self):
        response = self.response(headers={'Content-Length': '3', 'Content-Range': 'bytes 0-1/10'})
        with self.assertRaisesRegex(ValueError, 'Content-Length'):
            self.make_reader(response).read(2)
        self.assertFalse(response.body_read)

    def test_short_and_long_body(self):
        for body in [b'a', b'abc']:
            with self.assertRaisesRegex(ValueError, 'range length'):
                self.make_reader(self.response(data=body)).read(2)

    def test_encoded_response(self):
        response = self.response(headers={'Content-Length': '2', 'Content-Range': 'bytes 0-1/10', 'Content-Encoding': 'gzip'})
        with self.assertRaisesRegex(ValueError, 'Encoded'):
            self.make_reader(response).read(2)
        self.assertFalse(response.body_read)

    def test_reject_urls(self):
        for url in ['http://files.pythonhosted.org/a.whl', 'https://evil.test/a.whl',
                    'https://user@files.pythonhosted.org/a.whl',
                    'https://files.pythonhosted.org:444/a.whl',
                    'https://files.pythonhosted.org/a.whl?x=y',
                    'https://files.pythonhosted.org/a.whl#x',
                    'https://files.pythonhosted.org/a.tar.gz']:
            with self.assertRaises(ValueError):
                validate_url(url)

    def test_redirect_rejected_before_following(self):
        handler = CheckedRedirect()
        for url in ['http://files.pythonhosted.org/a.whl', 'https://evil.test/a.whl']:
            with patch('urllib.request.HTTPRedirectHandler.redirect_request') as follow:
                with self.assertRaises(ValueError):
                    handler.redirect_request(urllib.request.Request(URL), None, 302, '', {}, url)
                follow.assert_not_called()

    def test_final_destination_rejected(self):
        response = self.response(url='https://evil.test/a.whl')
        with self.assertRaises(ValueError):
            self.make_reader(response).read(2)
        self.assertFalse(response.body_read)

    def test_head_final_destination_rejected(self):
        response = Response(headers={'Content-Length': '10'}, url='http://files.pythonhosted.org/a.whl')
        with self.assertRaises(ValueError):
            RemoteWheel(URL, opener=Mock(return_value=response))

    def test_transfer_budget_and_negative_seek(self):
        reader = self.make_reader(self.response())
        RemoteWheel.transferred = 20 * MEMBER_LIMIT
        with self.assertRaisesRegex(ValueError, 'budget'):
            reader.read(2)
        with self.assertRaisesRegex(ValueError, 'Negative'):
            reader.seek(-1)


class MemberTests(unittest.TestCase):
    def test_oversized_registry_rejected_before_open(self):
        archive = Mock()
        archive.getinfo.return_value.file_size = MEMBER_LIMIT + 1
        with self.assertRaisesRegex(ValueError, '1MiB'):
            read_member(archive, 'rapidocr/default_models.yaml')
        archive.open.assert_not_called()

    def test_registry_at_limit(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr('rapidocr/default_models.yaml', b'a' * MEMBER_LIMIT)
        with zipfile.ZipFile(buf) as z:
            self.assertEqual(len(read_member(z, 'rapidocr/default_models.yaml')), MEMBER_LIMIT)

    def test_decompressed_size_mismatch(self):
        archive = Mock()
        archive.getinfo.return_value.file_size = 1
        archive.open.return_value = Response(b'ab')
        with self.assertRaisesRegex(ValueError, 'decompressed'):
            read_member(archive, 'registry')

    def test_lossy_preview_keeps_raw_bytes(self):
        raw = b'copyright \xff'
        record = notice_record(raw)
        self.assertEqual(record['text_decoding'], 'utf-8-replacement-lossy-preview')
        self.assertEqual(base64.b64decode(record['raw_base64']), raw)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), record['sha256'])

    def test_utf8_preview_is_strict(self):
        self.assertEqual(notice_record(b'license')['text_decoding'], 'utf-8-strict')


if __name__ == '__main__':
    unittest.main()
