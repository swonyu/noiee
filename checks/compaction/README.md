# Build174 compaction and recovery checks

Run from any working directory:

    python3 checks/compaction/run-suite.py

The runner resolves source relative to its tracked location. It executes 151 checks, writes a source-pinned receipt under .artifacts/compaction/runs, and checks that all source files stayed unchanged. Node defaults to /opt/homebrew/bin/node; pass --node PATH to qualify another explicit executable. --preserve-symlinks lets nested packages resolve through the owned node_modules link. No dependency is installed or modified.

## Product behavior

- Summary display has asynchronous, source-bound Active, partial progress, Stale, Available and failed/pending states. An old result cannot repaint another chat or changed settings. Validation uses an immutable snapshot.
- Request projection remains bound to original messages, context settings and selected summary through prepare/start. Draft edits and reasoning disclosure do not invalidate it.
- Use full history performs the existing structural snapshot CAS and changes only the active summary selection. Previous records, messages, draft, attachments and unknown metadata remain.
- Rebuild summary reserves the existing admission before asynchronous work, durably clears the selected summary, then explicitly summarizes from original history. It keeps prior records; Stop or a failed rebuild leaves originals in use. No old request is replayed.
- A v2 source records exact UTF-8 fragments of canonical exchange JSON, with source hashes, a contiguous byte cursor and the previous summary hash. Each explicit operation fits its entire escaped input envelope into 24,000 bytes. A partly processed exchange remains fully present in request projection; only completely processed earlier exchanges become summary-covered. The newest exchange and unsettled evidence stay in full.
- New compaction output uses a 12,000-byte raw UTF-8 bound and a 16,000-byte JSON-encoded carry bound. This leaves room for a following fragment even when summaries contain quotes, backslashes or control characters. Ordinary response generation remains uncapped. Historical records keep their original 32,000-byte validation bound; an oversized or escaping-heavy active legacy summary is retained and explicitly rebuilt from originals.
- v1 metadata migrates only on an explicit append. v2 retains up to 64 current and 2,048 archived attempts, with a 32 MiB compaction-metadata bound and encoded output space reserved before dispatch. Every archived record is preserved in storage/export/import; the active record stays current. Reaching a count or byte bound stops new admission without deleting anything. The existing 256 MiB chat snapshot and 128 MiB backend receipt-store bounds also remain.
- The Chat caller must use append(chat, job) inside its existing structural CAS, operationMessage(chat, job) for the post-activation notice, and stepHint for the Compact control titles. Other compaction APIs remain compatible. Cold inspection never starts a request; the next explicit Compact continues the saved cursor.
- Failed-startup inspection no longer depends on model readiness. Native list/review still checks signed transport, owner admission, result shape and authorization. Showing an existing saved continuation remains history-only. Preparing a new continuation requires the UI's actual Coding readiness and the backend's current profile checks, with separate native confirmations.

## Fixture coverage

| Fixture | Checks | Scope |
|---|---:|---|
| manual-check.mjs | 22 | Actual ChatRuns owner, tool-free dispatch, persistence/Stop, UTF-8/encoded carry limits, ordinary uncapped output and historical v5 compatibility |
| chunked-check.mjs | 33 | Exact fragment reconstruction, partial projection, cold cursor resume, legacy/escaped summary restart, archive count/byte bounds, import/export and source races |
| ui-handler-check.mjs | 6 | Actual slash-command interception and draft/attachment preservation |
| review-r2-check.mjs | 23 | Real outbound handler, admission gaps, Stop, source edits during SHA/prepare, unsettled evidence preservation |
| state-races-check.mjs | 29 | Actual helper/render/CAS/rebuild code in a capability-free VM |
| recovery-ui-check.mjs | 11 | Actual recovery button guard and optional-model native request |
| recovery-native-check.py | 14 | Actual Swift recovery method/bridge with fake native dialogs and signed transport |
| browser-check.mjs | 13 | Real UI and in-process server handler with fresh headless profile and fake inference |

The browser fixture opens no listening socket. Browser requests are intercepted and routed only to the in-process fixture handler. Original stores, native calls and real network access are guarded. The native fixture does not import AppKit or open UI; it uses a fake popup and approvals.

## Qualification limits and fixture corrections

These checks do not measure summary quality, model performance, installed application behavior or an integrated native build. They do not implement automatic compaction, a tokenizer-based context meter or Coding history compaction. The model summary itself remains derived and potentially lossy: these checks prove supplied-fragment coverage and retained provenance, not semantic completeness. Partial exchanges can be processed over several rounds, but remain fully projected until their final fragment is summarized.

Initial browser adaptation attempts failed before qualification: mapping the dependency resolver back to the same source recursed; normal realpath resolution could not find a nested SDK dependency. The final runner uses Node's --preserve-symlinks with the owned dependency tree.

Browser data initially under Documents/.artifacts acquired macOS com.apple.provenance metadata after durable receipt writes, changing ctime. The existing receipt guard correctly fenced these external changes on both Node26 and Node24. No production guard changed. The isolated browser data/profile now use a fresh Caches directory, as the prior qualified fixture did; evidence and screenshots stay in .artifacts. Initial failing Documents logs are retained there for diagnosis.


Manual backend fixtures also keep their generated receipt stores under a unique private `~/Library/Caches/NoieeCompaction172-manual-*` directory. A scoped Documents reproduction observed a completed receipt retain identical bytes, inode, mode, ownership, link count, size and mtime while ctime changed after the commit and `com.apple.provenance` was present; the unchanged backend correctly refused the outside change. Moving only generated fixture data avoids that unrelated writer. Logs and qualification reports remain under `.artifacts`; receipt stamps and all behavioral assertions are unchanged.

### Retained manual-fixture diagnosis (2026-11-07)

- Original failed aggregate: `/Users/saleh/Documents/Noiee/project/.artifacts/compaction/runs/20261107T012144Z-d462c199/RESULT.json`, SHA256 `efd77cff4a080b9746785687701772d3706068202e41dc9c27a6840cd58cffc8`. It remains a failed result.
- Documents reproduction: `/Users/saleh/Documents/Noiee/worktrees/compaction/.artifacts/compaction/manual-diagnostic-dwell-20261107T012629Z-750840a3/TRACE-CONCLUSION.json`, SHA256 `fc552c7a2bdb70eaa4ac194e8e583a0981557783b5aca8ac44a0b19d46db983a`. The unchanged backend rejected the outside change after a diagnostic-only 750ms settled-state dwell. Its trace records zero receipt mutation operations between the same-inode, same-content observations; only ctime changed. Raw observer code, command output and event trace are retained beside it.
- Same-dwell Caches verification: `/Users/saleh/Documents/Noiee/worktrees/compaction/.artifacts/compaction/manual-caches-dwell-20261107T012806Z-50ee076d/RESULT.json`, SHA256 `7628f5af4ab7388625bb378eac19e878ea4f7223f6df8c8b0552a108cf8f95e5`. All 19 existing checks passed, 531 metadata trace events showed no ctime-only change, and complete current production source hashes stayed unchanged. Network, child-process and original-store counters stayed zero.

The diagnostic dwell and observers are not part of the shipping fixture change. The committed fixture changes only its generated data location and records that root. Final aggregate qualification must still execute freshly after integration.

### Browser CAS readiness diagnosis (2026-11-07)

The outside-tab CAS case previously treated observing fake-provider dispatch as proof that browser reconciliation and draft saving were settled. That condition is too early: the browser can still hold the admitted intent/revision1 observation while the backend's running revision awaits its150ms checkpoint. `salehSaveBeforeLeave` also intentionally returns false if a run observation advances `reconcileSequence` during its asynchronous save.

- Original failed aggregate: `/Users/saleh/Documents/Noiee/project/.artifacts/compaction/runs/20261107T013006Z-de05e096/RESULT.json`, SHA256 `f842340488bd5cb124914cfa5f8b1180b9e53c775de53e873ec6230876cce030`. Its false-return assertion remains a failure.
- Controlled reproduction: `/Users/saleh/Documents/Noiee/worktrees/compaction/.artifacts/compaction/browser-save-interleave-20261107T013809Z-265f32ee/OBSERVATION.json`, SHA256 `565e1e7264b8f82a454560570e9d4031de3d5074a14744566551d98e9efb2279`. Delivering one valid existing live snapshot during snapshot commit changed the sequence11→12 and returned false. Hydration, attachment activity, recovery, structural writes and storage-block flags were all false; the draft had saved. The original failure lacked a phase trace, so this is a deterministic reproduction of the timing assumption, not a claim to have captured its exact schedule.
- Candidate verification: `/Users/saleh/Documents/Noiee/worktrees/compaction/.artifacts/compaction/browser-cas-ready-20261107T014046Z-4e439729/RESULT.json`, SHA256 `67148b2de29da5c1077854b4798dbb5fa4fe35ba7d7c8fb5fd4b7289f7d2fdac`. All13 browser cases passed with current production source unchanged. One actual durable running/revision2 observation was delivered during the first save; confirmations were `[false,true]`. All original outside-tab conflict, retained metadata/draft, explicit Apply and inference-count assertions passed.

The committed fixture waits for the exact newly admitted run's persisted running revision and exact draft, then requires a positively confirmed stable save before injecting the external CAS change. It keeps a bounded timeout and the exact CAS assertions. No production guard is changed, no false acknowledgement counts as success, and the diagnostic observer/interleaving hooks are not shipped.


### Build174 result and fixture correction

The initial new chunk fixture run retained six failed comparisons caused by cross-realm object prototypes in the capability-free VM. The comparison operands now use host structuredClone normalization; no product guard or behavioral assertion was relaxed. The retained trial is .artifacts/compaction174-trial-77414d3406/RESULT.json.

Independent review found that raw UTF-8 limits alone did not account for JSON escaping. Both carry admission and the metadata reservation now budget encoded bytes. Regression cases cover 12,000 backslashes/quotes, control-character expansion, a carry exactly at the encoded ceiling and activation near the actual 32 MiB metadata bound.

The final local runner passed all 151 checks with all source files unchanged. Its source-pinned receipt is .artifacts/compaction/runs/20261107T045128Z-2493f4ef/RESULT.json, SHA256 c1302d7e898fd1007b01b4b4c606d72cfea2b87a46a0dfccc79cdcadcd74660a. Chat caller integration and fresh native oversized-exchange/cold-resume acceptance remain separate gates owned by the integrating release.
