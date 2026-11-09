# Gmail native OAuth increment

This increment follows the independently reviewed GitHub stable-ID commit `0e418b04e41e4c9cccc3f04e584cea9ead79d15f`. It is source implementation with offline qualification, not live provider acceptance or a release. Build 180 and the Build 181 core release remain untouched.

## Feasible behavior after setup

A developer/user must register a **Google Desktop app** client, enable the Gmail API and configure OAuth consent for restricted `gmail.readonly`, with `openid email` for stable identity. No client ID is embedded or invented. The current documented Desktop flow does not require a client secret. External/Testing Gmail refresh tokens normally expire after seven days; Gmail password changes, revocation, administrator policy and provider token limits can also invalidate them. Production distribution of restricted scopes may require Google's verification/security assessment and policy compliance; this patch does not establish eligibility.

Use Noiee → Private Accounts → Configure Gmail. The native Connect review explicitly approves the exact scopes, persistent reads/refresh, the Google account the user chooses in the system browser, and the local Agent/saved-conversation destination. Google chooses and consents the account; Noiee verifies it before saving credentials and displays the verified email. A second duplicate confirmation is not added. Native controls, not model input or Full Access, initiate grants and revocation.

After successful setup:

- `gmail_messages`: query Gmail, returning at most 50 message/thread IDs per requested page and explicit continuation information.
- `gmail_message_metadata`: return From/To/Subject/Date headers and a snippet for one message ID.
- `status`: restore/verify the grant and display its verified account email.
- Restart, ordinary reads and token refresh do not add per-read or Resume prompts.

Full bodies, attachments, sending, draft creation, labels, deletion, arbitrary endpoints, token import, client registration and Drive are not exposed. The provider's `gmail.readonly` permission is broader than the app's currently exposed projections.

## Data destination

The current `agent.mjs` binds inference through `bindLocalModelTransport`. `validateLocalModelOrigin` admits only HTTP `127.0.0.1` origins without credentials, path, query or fragment, and its transport refuses another origin and redirects. The selected local model may change within that local destination. Native Gmail records require the `local-agent-conversation-v1` destination. Gmail metadata, snippets, queries and the verified account email can appear in local Agent context and the saved conversation.

Cloud model providers belong to separate Coding chats, not this Agent transport. Account tools are not added to Coding. Existing cloud Coding provider changes therefore do not change this connector's destination. A future cloud account-tool integration requires a new destination-specific native grant and reviewed routing; changing a stored destination fails validation. This does not assert that arbitrary same-user programs or a user-configured local server cannot forward information. Keychain and application routing are not an OS sandbox. Users can also intentionally copy/export conversation content separately.

GitHub's native consent wording was corrected to this actual local Agent route, without changing GitHub grant/read behavior or its publishing credential path.

## OAuth and identity

- A native Network.framework listener binds only `127.0.0.1` on an available ephemeral port before generating the redirect. No wildcard listener, remote callback or embedded web login is used.
- Authorization is fixed to Google's endpoint with S256 PKCE and independently random state, verifier and nonce. Each callback attempt consumes state once, including malformed/denied callbacks. Five-minute expiry, cancellation, wrong origin/port/path, duplicated parameters, oversized requests and HTTP request-smuggling forms fail closed.
- Token exchange uses only the fixed Google endpoint with form-encoded values. Codes, verifier, tokens, callback and authorization URLs never enter model output/history/logs. Generic browser callback text echoes nothing.
- Returned scope must match exactly Gmail readonly, OpenID and email. Google's `userinfo.email` equivalent is normalized. Partial or broader grants do not activate access.
- The initial ID token uses a bounded three-segment parser, strict RS256, fixed Google JWKS lookup, original signed bytes and Apple's RSA verification. No JWT-supplied key URL is followed. Issuer, audience, optional authorized party, expiry, issuance, exact nonce and optional access-token hash are checked.
- Stable account authority uses case-sensitive `sub`, not email. Fresh UserInfo for the same access token must match that subject, have verified email, and agree with Gmail's profile address. Account-email renames can update without granting a new subject. An alias mismatch currently fails closed rather than guessing which mailbox belongs to it.
- JWKS are fetched fresh for each new connection, not loaded from JWT-provided URLs or reused indefinitely. An unknown key fails the connection; no automatic token/code replay occurs.

## Storage, refresh, cancellation and revocation

Access/refresh tokens use a separate nonsynchronizing device-local Keychain record, with noninteractive locked-Keychain failure. Descriptions/reflection are redacted; typed requests have fixed HTTPS hosts/methods. Ephemeral HTTP sessions disable cookies, cache and credential storage, reject redirects, bound successful response streams and discard provider error bodies. Current account/response strings cannot echo either token to status/model output. Google identity tokens are not persisted.

Before refresh, the record becomes a durable token-free `refreshPending` tombstone. A confirmed, scope-checked replacement access token and same verified `sub` can reactivate it. Google may omit a replacement refresh token and response scope, in which case the prior refresh token and original exact scope are retained, per OAuth semantics. A supplied replacement refresh token replaces the old value. A refresh ID token is not used for authentication; current access-token identity is re-established through UserInfo and Gmail profile. Unknown/lost/cancelled refresh results or storage publication failures remain held, with no automatic old-token replay. Reconnection is a temporary conservative implementation requirement after uncertainty, not a new per-restart approval policy.

Read HTTP 403/404/429/5xx failures do not automatically revoke a usable grant. Token expiry, scope expansion or verified subject change blocks it. Cancellation discards late reads, callbacks and exchanges. A pending remote authorization cannot be undone merely by closing Noiee's panel.

**Disconnect locally** persists a non-secret deny marker before trying to overwrite tokens with a disconnected tombstone. Restore consults the marker before opening Keychain. Failure is explicit; if independent stores both fail, durable removal cannot be guaranteed. App-level single-writer checks are not cross-process protection against arbitrary same-user native code.

**Revoke project access** is a separate native confirmation. Google's revoke endpoint affects all scopes and tokens for all OAuth clients in that Cloud project for the account, potentially affecting Drive or other apps. Prefer a separate Gmail Cloud project. The app blocks local reads first and persists a `revocationPending` record, then submits the refresh token in a form body to the fixed revoke endpoint. A 200 response permits local token removal; Google notes propagation can take time. Failure/cancellation keeps access blocked and remote revocation explicitly unconfirmed. Only another native confirmation may retry. Local disconnect can remove that retry material without asserting remote success.

## Offline checks and remaining acceptance gates

Run `python3 -B tooling/check_gmail_accounts.py`, all commands in `PRIVATE_ACCOUNTS.md`, and the final-commit development native build. Fixtures inject HTTP, listener, store, consent, browser opening and the session-level identity-verifier result. The real RSA primitive is separately verified against RFC 7515 Appendix A.2's public modulus/exponent/signature, without private keys or generation. Production claim checks and negative full-JWT parsing are exercised independently. This is component and lifecycle coverage, not a real Google-signed positive token integration test.

The Gmail suite currently passes 187 assertions. Coverage includes PKCE/state/nonce/callback replay and expiry, HTTP parsing/limits, signed-message tampering, issuer/audience/authorized-party/access-hash checks, unsupported algorithms/key URLs, exact/partial/expanded scopes, provider/profile/subject mismatch, output redaction including escaped slash/quote/backslash credentials, automatic restore, renamed email, omitted/replaced refresh values, token expiry, invalid-grant/non-replay behavior, late cancellation, local storage failures, remote revoke denial/uncertainty/retry and local destination restrictions.

No test constructs the production Keychain store, HTTP transport, listener or UI; no network/auth/token exchange/browser/socket or installed app is used. Native source is compiled but not operated. Still required before a release: registered test client, actual system-browser loopback acceptance including late/duplicate requests, real Google ID-token/JWKS agreement, native layout/repeated clicks/close, real locked Keychain, provider refresh/revoke behavior, real URLSession redirect/stream bounds, app restart/Stop and Google policy review. No live approval is implied by the offline tests.

## References checked 2026-11-09

- [Google Desktop OAuth, PKCE, refresh and project-wide revocation](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google OAuth expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google OpenID validation](https://developers.google.com/identity/openid-connect/openid-connect) and [reference](https://developers.google.com/identity/openid-connect/reference)
- [OIDC ID-token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation), [UserInfo subject binding](https://openid.net/specs/openid-connect-core-1_0.html#UserInfoResponse)
- [OAuth refresh semantics](https://datatracker.ietf.org/doc/html/rfc6749#section-6)
- [Gmail profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), [list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [restricted scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Public RSA verification vector](https://www.rfc-editor.org/rfc/rfc7515.html#appendix-A.2)
