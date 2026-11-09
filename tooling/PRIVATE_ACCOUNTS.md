# Private-account connector foundation

This is an offline-tested foundation, **not a working account connection release**. The only Agent tool is `private_accounts` with `{ "action": "status" }`. It reports all three providers as unconfigured, with reads and grants unavailable. No configuration file, environment variable, model argument, MCP call, Full Access flag or existing `gh` login activates these connectors. There is no account-connect button pretending to succeed.

## Implemented code and limits

- `source/PrivateAccounts.swift`: native typed read operations, native credential-store interface and Keychain implementation, bounded HTTPS transport and provider-specific JSON projection, generation/cancellation fencing and local credential removal.
- Gmail: list one page of up to 50 message IDs, optional query/page token; get one message's From/To/Subject/Date headers and snippet. No full message body, attachments, send, draft or modification operation.
- Drive: get metadata of an ID in the native grant's selected-file set. No list-all, file content, export, download, upload, write or permission operation. A supplied file ID is not evidence that Google Picker granted it.
- GitHub: read a selected repository's basic metadata or one page of up to 50 issues/PR summaries. No contents, cloning, arbitrary REST URLs, GraphQL, publishing or issue writes. Existing GitHub publishing transport and its credential path are unchanged and independent.
- `source/PrivateAccountOAuth.swift`: Google S256 PKCE preparation plus single-use state, exact loopback callback binding, 5-minute expiry, duplicate query rejection, denial and cancellation. It requires a native consent callback before preparing a URL. It does not open a browser/listener, exchange a code, refresh a token, persist a grant or establish an account identity.

The typed grant struct is an internal contract for a future verified native coordinator, not provider permission evidence. Do not expose its initializer, decoder or the credential store to JavaScript/model tools. No production path constructs the reader, Keychain store or authorization coordinator. The status tool does not inspect existing credentials.

## Security boundaries

Credentials use a dedicated nonsynchronizing Keychain service, device-local/unlocked accessibility, no interactive read fallback and insert-only publication. No token is accepted from model arguments, passed to Node, logged or returned in tool results. Credential-bearing types redact standard descriptions and reflection. Provider errors are replaced with fixed messages, known credential strings are removed from selected result strings, and arbitrary JSON/error bodies are not forwarded.

These are application separation measures, **not an OS sandbox**. Keychain does not establish protection against arbitrary native code running as the same user or against model-directed unrestricted shell code. Existing Full Access remains a separate trust boundary. Read content would still become model/history data once a future read integration is enabled; it is untrusted text, not instructions. A future UI must explain exactly what data and selected model destination receive it.

Requests are fixed GET operations with fixed HTTPS hosts, paths, methods and query fields. Access tokens travel only in the Authorization header. The ephemeral URLSession has cookies, credential storage, caching and redirects disabled; response collection is capped at 256 KiB and 45 seconds. The parser exposes selected fields only. These transport properties are source-reviewed and compiled; the offline suite does not exercise a real URLSession server.

A 401/403 fences that provider in the reader. Cancellation discards late results, even if a transport ignores cancellation. Local disconnection cancels pending work and blocks further reads before attempting deletion; deletion failure stays blocked. Local disconnection does **not** revoke remote OAuth access. Revocation/refresh/reconnect coordination and durable revocation state are not implemented and must be completed before any production reader is created. New reader instances do not inherit the in-memory denial fence.

## Required next implementation

1. Obtain the user's approval for exact account permissions and the app registrations. Do not invent client IDs, inspect another app's tokens or borrow `gh` scopes. Maintain explicit account identity and selected-resource identity separately from a token.
2. Google: registered Desktop OAuth client, enabled Gmail/Drive APIs and configured consent screen. Gmail `gmail.readonly` is restricted; verification/security-assessment requirements depend on deployment and data handling. Installed-app incremental authorization is not supported. Choose distinct least-privilege requests and verify returned grants rather than silently broadening scope. External Google OAuth Testing refresh tokens generally expire after seven days for these scopes.
3. Complete native system-browser presentation and a listener bound exclusively to the selected loopback address/ephemeral port before constructing its redirect. Bind app instance, native consent, provider, account and outstanding operation. Keep code/verifier/URLs out of chat receipts. Implement fixed token endpoints, bounded parsing, token-type/scope/identity validation, cancellation at every await, atomic credential publication and refresh/revoke outcomes without retrying uncertain effects.
4. Drive: integrate Google Picker or a supported app-file selection flow. `drive.file` is per-file and allows modification at the provider, although this connector exposes only GET. Do not substitute full `drive.readonly` or a model-generated file ID for user selection. Persist and validate selection provenance with the grant.
5. GitHub: register a GitHub App with selected repositories and read-only metadata/issues permissions. The official device flow is suitable for desktop apps and does not require embedding an app secret/private key; enable it in the registration and implement native user code presentation plus bounded polling/slow-down/denial/cancel/expiry handling. Alternatively, a reviewed server-mediated flow may be used, but do not ship its confidential credentials in the app. Verify current user, app installation, permissions and allowed repository IDs before credential publication. No broad `repo` OAuth fallback.
6. Add native disconnect/revoke controls, durable invalidation and restart behavior, recovery/Stop wiring, actual account-bound read admission, selected-model disclosure, untrusted-result handling and source-bound tool receipts. Preserve read/grant unavailability until all required parts are reviewed together.
7. Run live acceptance only under separate user authorization: denied and granted consent, cancelled/late browser callback, locked Keychain, account switch, provider revocation, expiry, refresh failure, real redirects/stream caps, selected-file/repository denial and quit/relaunch. No live acceptance is established by this batch.

## Offline checks

From this checkout:

```sh
python3 -B tooling/check_private_accounts.py
/opt/homebrew/bin/node --check source/agent.mjs
/opt/homebrew/bin/node --preserve-symlinks tests/tool-actions-check.mjs
python3 -B tooling/build_native.py --build 181 --development
```

The dedicated check compiles only the connector sources and an offline Swift entry point, uses in-memory injected credential/HTTP fixtures and a disposable compiler cache/binary, and never constructs the production Keychain or URLSession implementation. It tests fixed endpoints/methods, query encoding, selected resources, cross-provider denial, malformed/oversized JSON, bounded pages, empty-mailbox evidence, no automatic retry, secret/error/reflection redaction, expired/denied/unconfigured grants, local removal failure, concurrent/cancelled/late reads, native consent denial, Google PKCE, wrong state/port/path/scope, duplicate callback fields, expiry, replay and cancellation during approval. These are synthetic tests, not network, Keychain, browser or installed-app acceptance.

Native development compilation includes the unchanged native computer self-checks but is unsigned and ineligible for release. Pre-existing compiler warnings may remain. No models, installations, package downloads or actual accounts are used.

## Official references verified 2026-11-09

- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google refresh-token expiry](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Drive per-file scopes and Picker](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [GitHub App user tokens and device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [GitHub Apps versus OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
