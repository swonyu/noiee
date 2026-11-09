"""Real self-authored child processes only; no converter or network operations."""
import os
import sys
import tempfile
import threading
import unittest
from research.bounded_process import Bounds, run_bounded


class ProcessTests(unittest.TestCase):
    def run_script(self, code, **kwargs):
        with tempfile.TemporaryDirectory(prefix='noiee-process-test-') as tmp:
            return run_bounded([sys.executable, '-I', '-c', code], cwd=tmp,
                               env={'PATH': '/usr/bin:/bin', 'HOME': tmp}, **kwargs)

    def test_normal_real_process(self):
        result = self.run_script('print("synthetic")')
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['output'], b'synthetic\n')

    def test_nonzero_process(self):
        result = self.run_script('raise SystemExit(7)')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['returncode'], 7)

    def test_output_bound(self):
        result = self.run_script('print("x"*10000)', bounds=Bounds(output_bytes=100))
        self.assertEqual(result['status'], 'output-limit')
        self.assertEqual(len(result['output']), 100)

    def test_wall_timeout(self):
        result = self.run_script('import time; time.sleep(10)', bounds=Bounds(wall_seconds=.15))
        self.assertEqual(result['status'], 'timeout')
        self.assertLess(result['elapsed_seconds'], 3)

    def test_cancel_before_start(self):
        event = threading.Event()
        event.set()
        result = self.run_script('raise RuntimeError("must not run")', cancel=event)
        self.assertFalse(result['started'])
        self.assertEqual(result['status'], 'cancelled')

    def test_cancel_running(self):
        event = threading.Event()
        timer = threading.Timer(.15, event.set)
        timer.start()
        try:
            result = self.run_script('import time; time.sleep(10)', cancel=event)
        finally:
            timer.cancel()
        self.assertEqual(result['status'], 'cancelled')
        self.assertLess(result['elapsed_seconds'], 3)

    def test_sampled_resource_limit_is_explicitly_injected(self):
        result = self.run_script('import time; time.sleep(10)',
                                 bounds=Bounds(rss_bytes=100), rss_sampler=lambda pid: 101)
        self.assertEqual(result['status'], 'rss-limit')
        self.assertEqual(result['peak_sampled_rss_bytes'], 101)

    def test_sampling_failure_stops_job(self):
        def fail(pid):
            raise RuntimeError('synthetic sampling failure')
        result = self.run_script('import time; time.sleep(10)', rss_sampler=fail)
        self.assertEqual(result['status'], 'resource-observation-failed')


if __name__ == '__main__':
    unittest.main()
