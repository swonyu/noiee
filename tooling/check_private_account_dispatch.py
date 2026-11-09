#!/usr/bin/env python3
"""Execute aggregate Stop tests against real sessions with their offline fixtures."""
from pathlib import Path
import subprocess
import tempfile
ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="noiee-account-dispatch-") as tmp:
    tmp = Path(tmp)
    # Reuse the existing injected fixtures, never their test entrypoints or live stores.
    fixture = tmp / "fixtures.swift"
    fixture.write_text((ROOT / "tooling/github_accounts_check.swift").read_text().split("@main struct GitHubAccountsCheck")[0] + "\n" +
                       (ROOT / "tooling/gmail_accounts_check.swift").read_text().split("@main struct GmailAccountsCheck")[0])
    sources = [ROOT / "source" / name for name in ["PrivateAccounts.swift", "GitHubAccount.swift", "GmailOAuth.swift", "GmailAccount.swift", "PrivateAccountsDispatch.swift"]]
    subprocess.run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", "-module-cache-path", str(tmp / "modules"),
                    *map(str, sources), str(fixture), str(ROOT / "tooling/private_account_dispatch_check.swift"), "-o", str(tmp / "check")], check=True, timeout=120)
    subprocess.run([str(tmp / "check")], check=True, timeout=30, env={"PATH":"/usr/bin:/bin", "HOME":str(tmp), "TMPDIR":str(tmp)})
