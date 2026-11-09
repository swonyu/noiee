# External tool artifacts, increment 1

This unreleased source adds a model-visible `external_tool_artifact` entry with
`install` and `inspect`. Installation stores one inert JavaScript module. It is
**not a working MCP connection**, and never imports, probes or executes that file.

Supported input is exactly one public `raw.githubusercontent.com` HTTPS `.mjs`
URL pinned to a full Git commit, an expected SHA-256 and a short purpose. Fetches
have a 1 MiB limit and a 20 second deadline. DNS answers must all be public and
are pinned for the direct TLS connection; the connected peer must match. All
redirects, credentials, queries, fragments, compression and ambiguous framing
are rejected. The model cannot supply request headers or transport dependencies.
No packages, archives, npm/Python installers, lifecycle hooks, extra files or
private accounts are supported. A source hash establishes identity, not trust.

A mandatory native sheet reviews the exact URL, hash, size and app-owned immutable
destination. Full Access cannot skip this sheet. Model arguments cannot supply a
grant or a path. Downloaded code and purpose text remain untrusted data. Decline,
Stop, changed app-parent identity and stale review never authorize publication.

Swift publishes descriptor-relative, exclusively created files with no-follow
ancestry and ownership checks. New revisions and receipts are retained under the
app-owned `external-tools-v1/revisions` directory; existing revisions are never
overwritten. Content and receipt files are read-only, but this is not an OS
security sandbox against other processes acting as the same Mac user. Failure
retains the stage or published revision for inspection. An installed receipt says
`launch: never-started`, describing this installation only. Existing `mcp.json`,
provider configuration, data, access preferences and boot markers are unchanged.

The next separately reviewed increment is responsible for usable connection,
runtime identity, one-shot launch authority, clean process environment and the
unconfined/recovery boot fence. There is no automatic migration or launch here.

## Executed offline checks

- `node source/external-artifact-download-check.mjs`: injected DNS/HTTPS streams;
  no network requests or downloaded execution.
- `node --preserve-symlinks source/external-artifact-route-check.mjs`: signed route,
  nonce replay, model forgery, Stop and durable Agent binding, no sockets.
- `python3 -B tooling/tests/test_external_tool_install.py`: disposable native
  filesystem fixtures and session/approval lifecycle, no native UI or external
  execution. Also verifies the explicit non-skippable review routing in source.

Actual native UI, a real download, installed-app behavior and usable external MCP
execution have not been tested or authorized by this development task.
