#!/usr/bin/env python3
"""Offline Gmail checks only: no browser, sockets, Keychain or live providers."""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="noiee-gmail-account-") as tmp:
    tmp = Path(tmp)
    subprocess.run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-module-cache-path", str(tmp / "modules"),
                    str(ROOT / "source/PrivateAccounts.swift"), str(ROOT / "source/GmailOAuth.swift"),
                    str(ROOT / "source/GmailAccount.swift"), str(ROOT / "tooling/gmail_accounts_check.swift"),
                    "-o", str(tmp / "check")], check=True, timeout=120)
    subprocess.run([str(tmp / "check")], check=True, timeout=30,
                   env={"PATH": "/usr/bin:/bin", "HOME": str(tmp), "TMPDIR": str(tmp)})
