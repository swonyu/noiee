# Native Google Drive Picker increment

This separate increment follows reviewed aggregate Stop commit `0a11cc4b8e81a5e5f836fdbffeca64ccab440463`. Existing Gmail/GitHub grant implementations are unchanged. It adds a Drive provider to the same guarded status dispatcher, native account panel and local Agent schema. Offline fixtures do not establish live Google/Picker/Keychain/UI interoperability or release readiness.

## Chosen design and setup

Current Google documentation supports a **desktop OAuth Picker in the system browser**. A hosted JavaScript bridge is not required. Register a Desktop OAuth client, configure consent, and enable **both Drive API and Google Picker API**. The native app needs its public client ID, not an embedded secret, API key, Web client, Picker app ID or JavaScript origin. Separate Gmail/Drive Cloud projects avoid coupling remote revocation. External/Testing non-identity grants normally expire after seven days. No registration, credentials, account grants or configuration were created or exercised by this task.

The authorization request uses `drive.file` alone, `prompt=consent`, `trigger_onepick=true`, multiple-file selection, S256 PKCE and random state. The documented Picker forbids combining other scopes, so this flow does **not** request OpenID/email or fabricate a Google `sub`. It uses the existing bounded loopback listener pattern; only `127.0.0.1` and an actual bound ephemeral port are accepted. The callback carries a code, exact scope and comma-separated `picked_file_ids`. Empty, missing, duplicate, malformed or over-limit IDs do not change a previous grant. Noiee imposes a 20-file limit, 256-byte identifier grammar and 8 KiB callback bound; these are defensive app limits, not claimed Google limits.

State and PKCE bind the OAuth session. Picker IDs are **not documented as signed or cryptographically committed to the code**. Before publishing a selection, Noiee validates state once, exchanges the corresponding code/verifier at the fixed Google token endpoint, checks exact returned scope, verifies the authenticated Drive account and retrieves each chosen file with the resulting token. Model arguments cannot configure clients, provide credentials, initiate a Picker, change saved IDs or revoke authorization.

## Scope comparison and truthful consent

`drive.file` is selected-file access, **not a read-only OAuth scope**: Google permits creation/modification of app-accessible files, which can include files previously authorized to this registered app. Noiee adds an exact current selected-ID allowlist and exposes only GET reads. A local replacement selection does not revoke earlier Google permissions. Native consent says all of this before opening Google.

The alternative `drive.readonly` grants account-wide file-content access even if Noiee builds a native selected-ID filter. For metadata-only browsing, `drive.metadata.readonly` is narrower, but still account-wide and restricted; it cannot retrieve contents. Those broader scopes are unnecessary for this Picker feature and are rejected. No silent fallback or scope union exists.

## Account and resource authority

`GET /drive/v3/about?fields=user(permissionId,emailAddress,me)` is supported under `drive.file`. Require `me == true` and a nonempty opaque `permissionId`; use email only as a display label. Google documents that permission IDs remain the same across files, folders and shared drives. It does **not** explicitly promise eternal immutability/never-reuse, and this ID is not an OpenID subject. The app binds to this Drive-specific identity and the exact Desktop client, rechecking identity on restore, refresh and reads. Changed names/emails may update; a different account/client requires local disconnect before choosing again.

Only IDs returned by a successful native Picker choice enter the saved selection. Every file must return its exact expected ID and `isAppAuthorized == true`. A new successful native choice replaces the local set rather than unioning provider-accessible or model-requested IDs. Cancelled/failed choices preserve the prior grant. An unsuccessful write during replacement sets the independent deny marker first, so restart cannot silently activate old or new selection. Ordinary status, reads, refresh and restart never add IDs.

Status names are explicitly labeled as last-verified metadata. Current metadata and access are checked when a file is read. HTTP 403/404/rate/server failures are not treated as proof that the saved authorization should be replaced; no data is returned from that request. No inventory search or arbitrary file discovery is exposed. File-level denial does not silently change the selected ID set.

## Delivered read operations

- `drive_file_metadata`: selected file ID, name, MIME type, version, modified time, optional size, trash state and whether supported text is currently readable. Resource keys and credentials are omitted.
- `drive_file_text`: complete bounded UTF-8 for an exact `text/plain` file through `files.get?alt=media`, or a plain-text rendition of an exact Google Docs document through `files.export?mimeType=text/plain`.
- `status`: verified account and the app's approved IDs/last-verified labels.

Text requires not trashed, current `capabilities.canDownload == true`, supported MIME and no known client-side encryption. An explicitly present encryption field must be `unencrypted`; malformed/unknown states fail. An absent field means no encryption information was reported, not a provider guarantee. The app then permits only strictly decoded bounded text and never attempts decryption. Shortcuts are not followed; select the actual target. Folders, binary files, PDFs, Sheets/Slides and other formats do not receive automatic conversion. Metadata may still be read for supported non-folder selections whose text format is unsupported.

Reads use fixed HTTPS GET endpoints, no arbitrary returned links, range requests, abuse acknowledgement, edits, uploads or deletions. For shared-drive metadata/media, `supportsAllDrives=true` is set; it is not invented for `files.export`. Known resource keys are sent only as the documented `X-Goog-Drive-Resource-Keys: fileId/resourceKey` header. Missing keys are never guessed or requested from model input. If access fails without an unavailable key, the operation stays unavailable. Resource-key length and forbidden header separators are defensive Noiee limits, not a Google-specified format.

Actual streamed response bytes and final serialized output are each bounded to **256 KiB**. Metadata size provides early rejection for plain-text blobs and, when reported, must equal the received byte count before a result is marked complete. Docs export size is not compared to the stored document size. Google's separate export ceiling is 10 MB. Only success status 200 and a normalized `text/plain` response with supported encoding are accepted; strict UTF-8/control-character validation follows. This header/encoding policy is intentionally conservative: Google documents byte responses but does not guarantee an exact MIME/charset for every case. Partial, binary, invalid, oversized or truncated content is rejected, never returned as a complete file.

Metadata is fetched immediately before and after content; full checked metadata, including ID, MIME, increasing Drive version and current permissions, must agree. The authenticated account is checked again before publication. Change or failed recheck discards the text. This is conservative detection, not a provider-guaranteed atomic snapshot. Docs text exports do not preserve formatting, images, comments or assured multi-tab fidelity.

## Persistence, destination and cancellation

Dedicated device-local nonsynchronizing Keychain records hold tokens/resource keys, with noninteractive failure while locked. Their descriptions/reflection are redacted. Actual returned strings and object keys are recursively checked against current access/refresh tokens and known resource keys before model output. Credentials never enter URLs, tool arguments, logs or conversation history. Fixed typed requests, no redirect following, no cookie/cache/credential storage, bounded streams and discarded provider error bodies retain the Google account transport boundary.

The native grant authorizes persistent reads/refresh only for the same verified account, Desktop client, selected IDs and `local-agent-conversation-v1` destination. Data reaches the selected **local Agent model** through Noiee's loopback LM Studio transport and this app's saved conversation. Cloud Coding providers do not receive this connector. This does not constrain forwarding performed by a separately configured local server, arbitrary same-user native code, or deliberate user copying/exporting. The app is not an OS sandbox.

Refresh stores a token/key-free pending tombstone before dispatch. Verified same-account/exact-scope responses can replace it; missing replacement refresh token or scope inherits the prior exact grant. Uncertain/cancelled refresh or failed publication never replays the old token automatically. Normal restart/read/refresh adds no Resume or per-read confirmation.

Local disconnect persists a deny marker before overwriting tokens and resource keys with a non-secret tombstone. Remote revocation is a separate native confirmation displaying account and Desktop client ID and explaining that **all clients/scopes in the Cloud project** can be affected, including Gmail. Unconfirmed revocation remains blocked with native-only retry material. A 200 reply allows local secret removal, with provider propagation caveats. Storage failures are explicit; independent-storage failure can prevent guarantees of durable removal.

Native Cancel, close, page departure and Stop cancel work and discard late results. Aggregate status uses `PrivateAccountsDispatch` checks before and after every provider and final publication. A provider returning a normal held status after cancellation cannot start the next provider's restore/read/refresh or publish a late aggregate.

## Offline validation and live gates

`python3 -B tooling/check_drive_accounts.py` currently passes **208** assertions. HTTP, credential stores, listener, browser opening and native consent are injected. The suite does not construct the real URLSession transport, listener, Keychain or UI. Cases cover Picker/PKCE/state replay, scope/account/file validation, selection replacement and preservation, unsupported formats and restrictions, actual byte/output limits, pre/post changes, escaped token/resource-key echoes, restore/refresh, storage failure, revocation and late cancellation.

`python3 -B tooling/check_private_account_dispatch.py` now passes **21** assertions, including actual injected Drive sessions. It proves an expired subsequent Drive grant never starts a refresh after earlier Stop, and cancelled Drive status cannot publish or start subsequent work. All existing Gmail/GitHub/foundation gates, static local destination/routing checks and native compilation remain required.

Live acceptance is still required: registered client/APIs, actual browser Picker and loopback callback, real returned scope/IDs/user/metadata, resource-key cases, real Keychain lock/restart, download/export MIME behavior, version changes, large response/redirect handling, cancel/repeated native controls and layout. App panels are scrollable to keep consent/setup controls accessible, but visual behavior was compiled, not operated. This task made no real auth/API requests, downloads, browser/UI actions or user-store changes.

## Official sources checked 2026-11-09

- [Desktop/mobile Picker](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker), updated 2026-10-12; [Picker overview](https://developers.google.com/workspace/drive/picker/guides/overview)
- [Native OAuth/PKCE/refresh/revoke](https://developers.google.com/identity/protocols/oauth2/native-app), [expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [metadata-only restrictions](https://developers.google.com/workspace/drive/api/guides/file-metadata)
- [about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get), [User](https://developers.google.com/workspace/drive/api/reference/rest/v3/User), [permission-ID stability](https://developers.google.com/workspace/drive/api/guides/manage-sharing)
- [files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get), [files.export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export), [export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats)
- [Download controls](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [file fields/version/encryption](https://developers.google.com/workspace/drive/api/reference/rest/v3/files), [content restrictions](https://developers.google.com/workspace/drive/api/guides/content-restrictions)
- [Shortcuts](https://developers.google.com/workspace/drive/api/guides/shortcuts), [resource keys](https://developers.google.com/workspace/drive/api/guides/resource-keys)
