# Reviewed external JavaScript tools

Unreleased development source, based on frozen Build181 source 49b2232. Commit
734ac72 is independently reviewable inert installation only. The subsequent
increment adds connection, lifecycle receipts and explicit restart handling.
Neither increment installs or replaces the user's running app.

## Supported capability

The model-visible `external_tool_artifact` supports `install`, `inspect`,
`connect`, `disconnect` and `status`. An install request is exactly:
`{action:"install",url,sha256,purpose}`. Connection uses an installed SHA-256
revision, not a command, path, environment, credential or approval flag.

Only this URL form is supported:
`https://raw.githubusercontent.com/<owner>/<repo>/<40-lowercase-hex-commit>/<path>.mjs`.
The module must be self-contained. Built-in Node imports work; relative/package
imports do not. Other hosts, npm/Python packages, archives, dependency trees,
install scripts, native addons, private accounts and custom arguments are not
supported. Downloaded source is never evaluated to discover dependencies.

Fetches have a 1 MiB strict UTF-8/no-NUL limit and 20 second deadline. Every DNS
answer must be public and a selected address is pinned for direct TLS; the peer
must match. IPv6 is deliberately restricted to GitHub's 2606:50c0::/32. All
redirects, URL credentials/queries/fragments, compression and ambiguous framing
are refused. No cookies, authorization headers or caller-selected transport
settings are sent. The fixed host plus expected SHA does not establish trust.

## Native review and execution

Installation and execution currently require **two separate native reviews**:

1. Install inert file once: exact URL, hash, byte count, app-owned immutable
   destination and model-supplied untrusted purpose. No import, help/version
   probe, package manager or downloaded code runs.
2. Connect once: exact revision/receipt, source provenance, qualified Node
   identity, fixed loader arguments, explicit clean environment, private
   storage paths, actual MCP configHash, generation and five-minute lifetime.

Both reviews use `operational:false`; Full Access cannot skip them. Model
arguments cannot mint/echo a native grant. The backend consumes the exact
prepared request before awaiting; a separate private one-shot capability is
consumed immediately before spawning. Existing MCP HMAC configHash validation
is retained. Config mutation, replay, Stop and stale generations refuse launch.

The verified source snapshot travels over a private inherited fd3 pipe. A fixed
trusted loader rechecks the 1 MiB limit and exact SHA before importing a data URL;
Node never reopens the artifact path for execution. MCP stdin remains separate.
No downloaded source is placed on argv or in the environment. The child receives
only HOME, TMPDIR, PATH, LANG and LC_ALL, without ambient NODE_OPTIONS, agent
sockets, app credentials or authentication tokens.

Execution runs **as the Mac user, not in an OS sandbox**. Private HOME/cwd are
storage separation only. The module can access other host files/network and
spawn descendants. The existing qualified Node runtime contract is unchanged:
canonical executable/ancestor identities and exact file digest/version are
rechecked. The executable leaf must be owned, executable and not group/world
writable. Existing Homebrew ancestor permissions are not changed or newly
forbidden. Preflight checks are not proof against another same-user process
mutating the runtime between check and exec or against loader/dependency changes.
This feature does not sandbox or redesign existing Full Access shell tools.

Launch is permitted only if the backend already started with
`unconfinedBoot:true` and `recoveryStartup:false`, plus both existing worktree and
Coding unconfined-access checks. Clean reviewed boots can install inertly but
must use the existing supported access-mode/restart transition before launch.
The feature never writes/clears boot markers or changes access preferences.

## Storage and lifecycle

Swift publishes immutable owned revisions with held ancestor descriptors,
no-follow checks, single-link files, exclusive creation and atomic no-overwrite
publication. Files are 0400 and managed directories 0700. Existing mcp.json,
providers and installed revisions are preserved. Managed server IDs use
`external-js-<sha>` in a separate in-memory registry; collisions fail closed.
No external server is automatically recovered or granted trusted-read status.
Tool descriptions and schemas remain untrusted.

Before commit, Swift atomically publishes a pending launch receipt and private
home/tmp/work directories. Outcomes and owned-process closures are separately
appended, never substituted for each other. Lost responses/crashes leave
uncertainty. Stop/Disconnect closes owned transport, not proof that detached
children or prior effects are gone. Successful closures are persisted even if a
separate provider's Stop failed.

After normal Disconnect/Stop/quit and reopen, a verified owned closure permits a
new mandatory Connect review. A proven pre-spawn `not-started` outcome also
permits fresh review. Otherwise the native flow first displays the exact prior
uncertainty and asks **Acknowledge prior uncertainty**, then separately asks
**Connect once**. This acknowledgment preserves prior evidence, does not claim
cleanup and does not itself run code. It is bound to exact prior receipt hashes;
new/mutated history requires another review. An active or unconfirmed owned
process must first complete an explicit Disconnect. No manual receipt deletion,
automatic retry or automatic reconnect is used.

To select a prior revision, disconnect the current one and request Connect for
the retained earlier SHA. This does not undo effects of any executed code.
Storage is bounded to 64 retained entries per native collection; no automatic
pruning/deletion UI is implemented. Invalid/tampered owned storage fails closed
and may need separate support; the re-arm UI does not authorize altered evidence.

## Verification and limits

Executed disposable checks include:

- `node source/external-artifact-download-check.mjs`: injected DNS/HTTPS streams.
- `node --preserve-symlinks source/external-artifact-route-check.mjs`: signed
  routes, replay, forged fields, Stop and lost-response cancellation, no sockets.
- `node --preserve-symlinks source/external-tool-claims-check.mjs`: six actual
  durable ChatRuns claim families, altered/replayed claims and model-made commits.
- `python3 -B tooling/tests/test_external_tool_install.py`: 60 native assertions.
- `python3 -B tooling/tests/test_external_tool_launch.py`: 76 native assertions,
  exact Node-to-Swift review/digest parity and fixed loader parity.
- `node --preserve-symlinks source/external-tool-runtime-check.mjs`: private
  grants, boot/recovery/config/artifact fences, cancellation, restart closures,
  re-arm, uncertainty and clean-env snapshot transport. Only locally generated
  synthetic fixture code executes; no downloaded/unknown artifact executes.
- Existing `mcp-check.mjs` and `mcp-boundary-check.mjs` regression suites.
- Full native compilation and built-in native checks via
  `python3 -B tooling/build_native.py --build 181 --development`. Development output is not
  release-eligible or installed-app acceptance.

A reviewer observed one superseded development-run failure at runtime fixture
line 32: expected connected, received not-started (session 57008, Node v26.13.0).
Source edits overlapped; no exact source hash or returned error was captured.
Its cause remains unproven. Error-rich assertions were added and fixtures moved
outside the source tree. Twenty sequential tests passed on the subsequently
frozen runtime source, plus explicit timing faults. This is not presented as a
diagnosed failure or proof from reruns alone; independent review must assess the
final immutable commit and retained caveat.

No real download, unknown artifact launch, native consent UI, production
transport, installed-app acceptance, model, credential or live account testing
has been performed. Those require separately authorized testing before claiming
working real-world providers. Review receipts are app-owned records, not an OS
security boundary against other code running as the same user.
