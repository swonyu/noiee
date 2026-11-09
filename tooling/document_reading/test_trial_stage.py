"""Offline staging validation; never downloads or installs packages."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.request
from research.trial_stage import NoRedirect, stage, verify_package


class StageTests(unittest.TestCase):
    def row(self):
        return {'filename': 'sample-1.0-py3-none-any.whl',
                'wheel_url': 'https://files.pythonhosted.org/packages/sample-1.0-py3-none-any.whl',
                'sha256': 'a'*64, 'bytes': 42}

    def test_valid_url_metadata(self):
        verify_package(self.row())

    def test_untrusted_download_targets(self):
        for url in ['http://files.pythonhosted.org/sample.whl', 'https://evil.test/sample.whl',
                    'https://user@files.pythonhosted.org/sample.whl',
                    'https://files.pythonhosted.org:444/sample.whl']:
            row = self.row()
            row['wheel_url'] = url
            with self.assertRaises(ValueError):
                verify_package(row)

    def test_filename_size_and_digest(self):
        for field, value in [('filename','../bad.whl'), ('filename','another.whl'),
                             ('bytes', True), ('bytes', 0), ('bytes',81*1024*1024),
                             ('sha256','G'*64), ('sha256','a'*63)]:
            row = self.row()
            row[field] = value
            with self.assertRaises(ValueError):
                verify_package(row)

    def test_wrong_plan_stops_before_network_or_wheelhouse(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'plan.json'
            path.write_text(json.dumps({'packages':[self.row()]}))
            opener = Mock()
            with self.assertRaises(ValueError):
                stage(path, Path(tmp)/'wheels', opener=opener)
            opener.assert_not_called()
            self.assertFalse((Path(tmp)/'wheels').exists())

    def test_redirect_stops_before_new_request(self):
        with patch('urllib.request.HTTPRedirectHandler.redirect_request') as follow:
            with self.assertRaises(ValueError):
                NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test/a.whl')
            follow.assert_not_called()


if __name__ == '__main__':
    unittest.main()
