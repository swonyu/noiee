# Build172 compaction and recovery checks

Run from any working directory:

    python3 checks/compaction/run-suite.py

The runner resolves source relative to its tracked location. It executes 115 checks, writes a source-pinned receipt under .artifacts/compaction/runs, and checks that all source files stayed unchanged. Node defaults to /opt/homebrew/bin/node; pass --node PATH to qualify another explicit executable. --preserve-symlinks lets nested packages resolve through the owned node_modules link. No dependency is installed or modified.

## Product behavior

- Summary display has asynchronous, source-bound Active, Stale, Available and failed/pending states. An old result cannot repaint another chat or changed settings. Validation uses an immutable snapshot.
- Request projection remains bound to original messages, context settings and selected summary through prepare/start. Draft edits and reasoning disclosure do not invalidate it.
- Use full history performs the existing structural snapshot CAS and changes only the active summary selection. Previous records, messages, draft, attachments and unknown metadata remain.
- Rebuild summary reserves the existing admission before asynchronous work, durably clears the selected summary, then explicitly summarizes from original history. It keeps prior records; Stop or a failed rebuild leaves originals in use. No old request is replayed.
- Summaries cover whole complete earlier exchanges only. The 24,000 UTF-8 byte input limit, unfinished boundaries and 64-record limit are stated honestly. An oversized exchange is never partially covered or silently omitted. Message positions and exchange counts replace opaque range IDs.
- Failed-startup inspection no longer depends on model readiness. Native list/review still checks signed transport, owner admission, result shape and authorization. Showing an existing saved continuation remains history-only. Preparing a new continuation requires the UI's actual Coding readiness and the backend's current profile checks, with separate native confirmations.

## Fixture coverage

| Fixture | Checks | Scope |
|---|---:|---|
| manual-check.mjs | 19 | Actual ChatRuns owner, finite tool-free summary dispatch, persistence/Stop, source and result binding |
| ui-handler-check.mjs | 6 | Actual slash-command interception and draft/attachment preservation |
| review-r2-check.mjs | 23 | Real outbound handler, admission gaps, Stop, source edits during SHA/prepare, unsettled evidence preservation |
| state-races-check.mjs | 29 | Actual helper/render/CAS/rebuild code in a capability-free VM |
| recovery-ui-check.mjs | 11 | Actual recovery button guard and optional-model native request |
| recovery-native-check.py | 14 | Actual Swift recovery method/bridge with fake native dialogs and signed transport |
| browser-check.mjs | 13 | Real UI and in-process server handler with fresh headless profile and fake inference |

The browser fixture opens no listening socket. Browser requests are intercepted and routed only to the in-process fixture handler. Original stores, native calls and real network access are guarded. The native fixture does not import AppKit or open UI; it uses a fake popup and approvals.

## Qualification limits and fixture corrections

These checks do not measure summary quality, model performance, installed application behavior or an integrated native build. They do not implement automatic compaction, a tokenizer-based context meter, partial-exchange compaction or Coding history compaction.

Initial browser adaptation attempts failed before qualification: mapping the dependency resolver back to the same source recursed; normal realpath resolution could not find a nested SDK dependency. The final runner uses Node's --preserve-symlinks with the owned dependency tree.

Browser data initially under Documents/.artifacts acquired macOS com.apple.provenance metadata after durable receipt writes, changing ctime. The existing receipt guard correctly fenced these external changes on both Node26 and Node24. No production guard changed. The isolated browser data/profile now use a fresh Caches directory, as the prior qualified fixture did; evidence and screenshots stay in .artifacts. Initial failing Documents logs are retained there for diagnosis.
