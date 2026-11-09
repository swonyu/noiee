#!/usr/bin/env python3
"""Run an unchanged focused fixture, recording each completed subprocess and inputs.

Instrumentation only: this is not a security boundary. The outer runner imposes
network denial, a clean environment, timeout, log bound and an owned process group.
"""
from pathlib import Path
import hashlib
import json
import os
import runpy
import stat
import subprocess
import sys

fixture, destination = sys.argv[1:]
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
sequence = 0
OriginalPopen = subprocess.Popen


def identity(path):
    path = Path(path).resolve(strict=True)
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 256 * 1024 * 1024:
        raise ValueError('Unexpected subprocess input')
    data = path.read_bytes()
    after = path.stat()
    keys = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_mtime_ns', 'st_ctime_ns')
    if any(getattr(before, key) != getattr(after, key) for key in keys):
        raise ValueError('Subprocess input changed during read')
    return {'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class RecordedPopen(OriginalPopen):
    def __init__(self, args, *other, **kwargs):
        global sequence
        if not isinstance(args, (list, tuple)) or kwargs.get('shell'):
            raise ValueError('Only explicit subprocess argv is accepted')
        argv = [str(arg) for arg in args]
        sequence += 1
        self.evidence = {'sequence': sequence, 'executable': str(kwargs.get('executable') or argv[0]), 'argv': argv,
                         'cwd': str(kwargs.get('cwd') or os.getcwd()), 'executableIdentity': identity(kwargs.get('executable') or argv[0])}
        self.inputs = {arg: identity(arg) for arg in argv[1:] if arg.startswith('/') and Path(arg).is_file()}
        self.evidence['inputsBefore'] = self.inputs
        self.output_path = Path(argv[argv.index('-o') + 1]) if argv[:2] == ['/usr/bin/xcrun', 'swiftc'] else None
        self.recorded = False
        super().__init__(args, *other, **kwargs)

    def wait(self, *args, **kwargs):
        code = super().wait(*args, **kwargs)
        if not self.recorded:
            self.recorded = True
            self.evidence.update(exitCode=code, inputsAfter={name: identity(name) for name in self.inputs},
                                 outputs=[identity(self.output_path)] if code == 0 and self.output_path else [])
            raw = (json.dumps(self.evidence, sort_keys=True) + '\n').encode()
            if len(raw) > 65536 or os.lseek(fd, 0, os.SEEK_CUR) + len(raw) > 1024 * 1024:
                raise ValueError('Subprocess evidence exceeds bound')
            os.write(fd, raw)
            os.fsync(fd)
        return code


subprocess.Popen = RecordedPopen
sys.argv = [fixture]
try:
    runpy.run_path(fixture, run_name='__main__')
finally:
    os.close(fd)
