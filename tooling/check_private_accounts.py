#!/usr/bin/env python3
"""Compile/run the native private-account foundation against offline injected fixtures only."""
from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def main():
    with tempfile.TemporaryDirectory(prefix="noiee-private-accounts-") as tmp:
        tmp = Path(tmp)
        command = ["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-module-cache-path", str(tmp / "modules"),
                   str(ROOT / "source/PrivateAccounts.swift"), str(ROOT / "source/PrivateAccountOAuth.swift"),
                   str(ROOT / "tooling/private_accounts_check.swift"), "-o", str(tmp / "check")]
        subprocess.run(command, check=True, timeout=120)
        subprocess.run([str(tmp / "check")], check=True, timeout=30,
                       env={"PATH": "/usr/bin:/bin", "HOME": str(tmp), "TMPDIR": str(tmp)})

if __name__ == "__main__":
    main()
