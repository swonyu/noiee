#!/usr/bin/env python3
"""Offline GitHub native-account flow checks. No live provider, browser or Keychain."""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="noiee-github-account-") as tmp:
    tmp = Path(tmp)
    subprocess.run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-module-cache-path", str(tmp / "modules"),
                    str(ROOT / "source/PrivateAccounts.swift"), str(ROOT / "source/GitHubAccount.swift"),
                    str(ROOT / "tooling/github_accounts_check.swift"), "-o", str(tmp / "check")], check=True, timeout=120)
    subprocess.run([str(tmp / "check")], check=True, timeout=30,
                   env={"PATH": "/usr/bin:/bin", "HOME": str(tmp), "TMPDIR": str(tmp)})
