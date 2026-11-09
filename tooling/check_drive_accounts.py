#!/usr/bin/env python3
"""Drive Picker/read fixtures only. Never invokes live provider, UI, listener or store."""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="noiee-drive-account-") as tmp:
    tmp = Path(tmp)
    sources = [ROOT / "source" / name for name in ["PrivateAccounts.swift", "GmailOAuth.swift", "GmailAccount.swift", "DriveOAuth.swift", "DriveAccount.swift"]]
    subprocess.run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-module-cache-path", str(tmp / "modules"),
                    *map(str, sources), str(ROOT / "tooling/drive_accounts_check.swift"), "-o", str(tmp / "check")], check=True, timeout=120)
    subprocess.run([str(tmp / "check")], check=True, timeout=30, env={"PATH":"/usr/bin:/bin", "HOME":str(tmp), "TMPDIR":str(tmp)})
