# Private accounts: native Gmail and GitHub, Drive foundation

This isolated branch is not part of the Build 181 core release. It has not accessed a live account, browser, Keychain, installed app or model. Source implementation and offline validation do not establish live acceptance.

## Available after the user's GitHub App setup

Use the native Noiee menu **Private Accounts…**. Enter an existing GitHub App's public slug and client ID. This app must support device flow and request exactly Metadata: Read and Issues: Read. Its installations must use selected repositories. Public app metadata must be readable from GitHub's `/apps/{slug}` endpoint.

Noiee verifies the registered client/app identity and permissions before asking to start device authorization. The user enters the displayed code themselves at `https://github.com/login/device` and grants access there. Noiee then verifies the authenticated account, app installations and selected repository IDs. A native picker selects one installation; a second native review shows the exact account and repository list and authorizes persistent read access, model/history disclosure and token refresh. Full Access cannot skip either review. Model tool arguments cannot start configuration, consent, browser login or token import.

After that exact native grant, `private_accounts` supports:

- `status`: verifies a saved GitHub grant and reports approved repository names. Missing registration/grant stays unconfigured.
- `github_repository` with `repository`: basic metadata for an approved repository.
- `github_issues` with `repository` and `page`: up to 50 issue/PR summaries for an approved repository, with explicit page/may-have-more metadata.

Reads and restore after app restart run automatically within the same verified grant. No recurring Resume or per-read confirmation is added. Returned content goes to Agent's selected local model through its fixed loopback LM Studio transport and this app's saved conversation, and remains untrusted data. Cloud providers belong to separate Coding chats; these native account tools are not exposed there. A future cloud destination requires a new explicit native grant. No mail sending, file mutation, cloning, publishing, issue writes, arbitrary URLs, PAT import or broad `repo` OAuth scope is exposed. Existing GitHub publishing and its `gh` credential path remain unchanged and separate.

## Credential and lifecycle boundaries

`GitHubAccount.swift` implements typed fixed HTTPS device/poll/refresh/identity/installations/repository/read operations. The ephemeral URLSession rejects redirects, disables cookies/cache/credential storage, bounds successful JSON collection, and never forwards provider errors. GitHub device-flow refresh is secretless. Only expiring `ghu_`/`ghr_` token pairs with the documented bearer/empty-scope response are accepted.

Tokens are stored only in a dedicated nonsynchronizing, device-local/unlocked Keychain record, never Node, JavaScript, arguments, tool output or logs. Credential-bearing types redact descriptions and reflection. An independent non-secret deny marker in this app's defaults blocks restore before Keychain access. Missing or malformed marker state does not activate saved credentials. A locked Keychain fails without a login prompt. Actual Keychain behavior remains untested.

Every restore/read verifies the original app/client, user, installation and installation-owner IDs, exact read permissions, selected-repository mode and suspension state. Authority follows those stable IDs and the saved repository IDs, not names. Verified account, app, owner and repository renames update persisted display/routing metadata without another grant. Complete inventories can only intersect the saved repository IDs: newly added IDs are ignored, confirmed removals are persisted before returning data, and a removed ID cannot silently return after restart or provider reappearance. No remaining approved repositories, identity changes or permission expansion disable the saved grant. New repository IDs require a fresh native grant.

A reduction first persists the independent deny marker, writes the smaller selection, then clears the marker. A failed write therefore blocks restore rather than reviving removed IDs. Only one installation is accepted per native grant; inventories are complete within 100 installations/repositories, fetched in pages of 20. Over-limit, incomplete, inconsistent or failed inventories fail the current operation without treating missing pages as confirmed removals. For usable non-rotating reads, HTTP 403/404/429/5xx similarly preserve saved authority without returning data; a later explicit request can verify again. A failure during token rotation can still leave the deliberately non-replayable `refreshPending` state. HTTP 401 disables the grant. Data results are checked again against current identity/resource membership before return. A stale repository name or an individual removed repository returns a fixed selection-changed error while preserving other approved IDs. This does not claim atomicity against an adversarial provider changing a path twice between checks.

Before refreshing, the store durably replaces tokens with a `refreshPending` record. Only a verified rotated pair can replace it. Cancellation, a lost response or publication failure leaves access held, and the old refresh token is not automatically replayed, including after restart. Read cancellation discards late results. Native Stop, page departure and window-close cancel in-flight local work; they cannot undo a provider grant already accepted.

Native **Disconnect locally** first persists the deny marker, then replaces both tokens with a non-secret disconnected record. This prevents restore even if Keychain removal fails after the marker is saved. Storage failures are explicit and require inspection/retry; if both independent stores fail, persistence cannot be guaranteed. These are single-native-writer application measures, not an OS sandbox or protection against arbitrary native code running as the same user. Keychain update is not a cross-process compare-and-swap against such code.

Local disconnect is **not remote revocation**. GitHub's token/grant deletion endpoints require the app's client secret; no such secret is embedded. The native help button opens GitHub's official instructions. The user must revoke the app themselves under GitHub Settings → Applications → Authorized GitHub Apps. A confirmed invalid token, identity/permission change, or complete loss of approved resources also disables local access. Cancelled/rejected native setup can leave a remote authorization already accepted; the UI explains that distinction.

## Gmail native flow; Drive remains unavailable

Gmail now has a native production flow after the user's registered Google Desktop client and consent setup. **Configure Gmail…** opens its own native panel. A single exact native Connect review authorizes `gmail.readonly`, `openid`, and `email`, the account the user chooses on Google's consent page, persistent refresh and disclosure only to the local Agent model plus this app's saved conversation. A verified account summary follows without a duplicate permission prompt. The saved record is bound to `local-agent-conversation-v1`; no cloud model or Coding destination is authorized.

`GmailOAuth.swift` binds a loopback listener before constructing its redirect, implements S256 PKCE, independent one-use state/nonce, strict callback expiry/replay validation, and RS256/JWKS identity verification. `GmailAccount.swift` verifies actual returned scopes, Google `sub`, UserInfo and Gmail profile agreement, then enables automatic restore/refresh and bounded message-ID search or headers/snippets. No full message bodies, attachments, mail writes or Drive reads are exposed. Dedicated Keychain handling and an independent deny marker separate credentials from model/output handling. These are not an OS sandbox against arbitrary same-user native code.

Local disconnect and Google project-wide revocation are distinct native controls. Remote revoke requires an explicit native confirmation explaining that all scopes/tokens across the project's OAuth clients may be affected. Uncertain revocation blocks reads and never claims remote success. See [Gmail design, prerequisites and validation](GMAIL_ACCOUNTS.md) for exact protocol, threat cases and untested live gates. No registrations, actual credentials, accounts, browser flows, listeners or Keychain records were exercised during development.

Drive also requires a real Google Picker or supported file-selection integration. `drive.file` grants per-file access and permits modifications at the provider, although this connector exposes only reads. Never substitute full Drive scope or an arbitrary model-supplied file ID for user selection. Selection provenance must remain bound to the verified account and grant. Drive cannot become usable merely by entering a client ID.

## Offline validation and remaining gates

```sh
python3 -B tooling/check_private_account_dispatch.py
python3 -B tooling/check_gmail_accounts.py
python3 -B tooling/check_github_accounts.py
python3 -B tooling/check_private_accounts.py
/opt/homebrew/bin/node tests/private-account-status-check.mjs
/opt/homebrew/bin/node tests/private-account-destination-check.mjs
/opt/homebrew/bin/node --check source/agent.mjs
/opt/homebrew/bin/node --preserve-symlinks tests/tool-actions-check.mjs
python3 -B tooling/build_native.py --build 181 --development
```

The native checks use injected in-memory HTTP/credential/listener fixtures and disposable compiler caches/binaries. They never construct production Keychain/URLSession/UI instances or launch the installed app. The GitHub suite has 256 assertions and the foundation suite has 197. A separate 17-assertion dispatch suite cancels after each provider and uses actual injected GitHub/Gmail sessions to prove a held result cannot start subsequent status/read/refresh work or publish a late aggregate. Tests cover native consent denial, bounded polling/slow-down, stable app/account/installation/resource identity, renames during restore/refresh, durable scope reduction and no re-admission, additions ignored, failed/incomplete/paginated inventories, transient HTTP failures, removal during a read, failed reduction publication, rejected broad/partial grants, token reflection/output redaction including escaped slash/quote/backslash refresh echoes, durable automatic restore, uncertain/cancelled refresh without replay, local revocation failures, late cancellation, schema restrictions and native-only consent routing. Foundation Google checks cover PKCE/state/callback expiry/replay/denial separately. Static UI checks do not establish visual usability, OS event origin or real browser lifecycle behavior.

Before inclusion in a release, independently review the final commit and run authorized live acceptance with registered test clients for both providers: actual native layout/repeated clicks/window close, device denial/expiry/slow-down, locked Keychain, logout/Stop/relaunch, account switch, provider revocation, repository changes, real redirect/stream limits, refresh rotation and local-disconnect failure handling. No accounts, settings, permissions, downloads, grants, actual Keychain records or installed app state were changed during implementation.

## Official references verified 2026-11-09

- [GitHub App device flow and expiring offline access](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refresh without a client secret for device-flow tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Public app identity and permissions](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#get-an-app)
- [Installation permissions and selected repositories](https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10)
- [Authenticated user identity](https://docs.github.com/en/rest/users/users?apiVersion=2026-03-10#get-the-authenticated-user)
- [Token/grant deletion requires app-secret authentication](https://docs.github.com/en/rest/apps/oauth-applications?apiVersion=2026-03-10)
- [User-operated GitHub App revocation](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps)
- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [token expiry](https://developers.google.com/identity/protocols/oauth2#expiration), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Drive per-file scopes and Picker](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

- [Google stable OpenID identity and validation](https://developers.google.com/identity/openid-connect/openid-connect), [Gmail profile fields](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
