"""Development-only process supervisor. Does not install/import Docling.
Caller supplies trusted argv and environment. Network denial belongs to the
reviewed sandbox wrapper, not this supervisor. RSS is sampled, not a hard limit.
"""
from dataclasses import dataclass
import os
import selectors
import signal
import subprocess
import time


@dataclass(frozen=True)
class Bounds:
    wall_seconds: float = 60.0
    output_bytes: int = 1024 * 1024
    rss_bytes: int = 2 * 1024 * 1024 * 1024


def group_rss_bytes(pgid):
    """macOS ps RSS units are KiB; sum only this job's process group."""
    result = subprocess.run(['/bin/ps', '-axo', 'pgid=,rss='],
                            capture_output=True, text=True, timeout=2, check=True)
    total = 0
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) == 2 and int(fields[0]) == pgid:
            total += int(fields[1]) * 1024
    return total


def run_bounded(argv, *, cwd, env, bounds=Bounds(), cancel=None, rss_sampler=group_rss_bytes):
    if bounds.wall_seconds <= 0 or bounds.output_bytes <= 0 or bounds.rss_bytes <= 0:
        raise ValueError('All limits must be positive')
    if cancel is not None and cancel.is_set():
        return {'status': 'cancelled', 'started': False, 'output': b'', 'returncode': None,
                'elapsed_seconds': 0.0, 'peak_sampled_rss_bytes': 0}
    start = time.monotonic()
    proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, start_new_session=True)
    output = bytearray()
    peak = 0
    status = None
    next_sample = start
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    os.set_blocking(proc.stdout.fileno(), False)
    try:
        while True:
            now = time.monotonic()
            if cancel is not None and cancel.is_set():
                status = 'cancelled'
            elif now - start >= bounds.wall_seconds:
                status = 'timeout'
            elif now >= next_sample:
                try:
                    peak = max(peak, rss_sampler(proc.pid))
                except Exception:
                    status = 'resource-observation-failed'
                if peak > bounds.rss_bytes:
                    status = 'rss-limit'
                next_sample = now + 0.1
            if status:
                break
            for key, _ in selector.select(timeout=0.025):
                data = os.read(key.fileobj.fileno(), min(65536, bounds.output_bytes - len(output) + 1))
                if not data:
                    selector.unregister(key.fileobj)
                elif len(output) + len(data) > bounds.output_bytes:
                    output.extend(data[:bounds.output_bytes - len(output)])
                    status = 'output-limit'
                    break
                else:
                    output.extend(data)
            if status:
                break
            if proc.poll() is not None and not selector.get_map():
                status = 'complete' if proc.returncode == 0 else 'failed'
                break
    finally:
        # Kill the entire group even after normal parent exit: no orphan workers.
        try:
            if proc.poll() is None or group_rss_bytes(proc.pid) > 0:
                os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS may race group teardown after the child has exited.
            # Only treat this as settled after observing no live group members.
            if proc.poll() is None or group_rss_bytes(proc.pid) > 0:
                raise
        proc.wait(timeout=5)
        selector.close()
        proc.stdout.close()
    return {'status': status, 'started': True, 'output': bytes(output),
            'returncode': proc.returncode, 'elapsed_seconds': round(time.monotonic() - start, 4),
            'peak_sampled_rss_bytes': peak}
