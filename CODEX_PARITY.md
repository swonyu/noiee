# Noiee: Codex workflow parity target

Reviewed on 2026-11-07 for the Build 176 source. This is an implementation map and critique, not a claim of complete product or model parity. Release qualification, the installed-runtime probe and installed native acceptance are separate evidence.

## Baseline

OpenAI describes the Codex harness in terms of persistent threads and turns, tools, approvals, interrupts and streamed events. Its desktop workflows also include project worktrees, review, Queue and Steer, skills, persistent Goals and side chats. An interface built around the harness does not establish equivalent model capability or access to managed services.

Primary references:

- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- [Mastering Codex remote for engineering](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)
- [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

## Build 176 scope

| Workflow | Implementation | Practical limit |
| --- | --- | --- |
| Load saved Tasks | Bounded parallel family verification in admitted history readers, display-only scan progress, verified page publication | Owner startup and retirement remain serial; native cold-start latency must be measured separately |
| Review Goal results | Responsive side inspector and exact acknowledged-turn navigation; separate editor and composer drafts | Older omitted turns remain unavailable through the direct link; manual evidence does not establish verification |
| Keep a task objective | Durable Goal bound to the exact owner, root, project, provider, model and execution mode; objective and Done when criteria | One Goal per task; completed contracts are retained and immutable |
| Continue deliberately | Continue goal starts one turn through ordinary native project, model, queue, Stop and owner admission | Each continuation is explicit; no automatic multi-turn pursuit |
| Bound attempts | User-visible 1–20 attempt limit, durable reservation before dispatch, retained failed/unknown outcomes | An uncertain start counts; this is not a token-cost budget |
| Pause and resume | Pause blocks the next continuation; Resume changes eligibility only | Current work continues until completion or existing Stop |
| Review completion | Manual completion evidence, original contract revision/digest and exact turn receipts | No automatic test/source verification or model-quality guarantee |
| Retain work safely | Editor and composer drafts remain separate; cold reads do not replay; stale or unavailable state holds writes | Ledger capacity is 64 contracts / 8 MiB; capacity refusal retains data |
| Investigate Chat submissions | Bounded Enter, Send, form and Retry observations in the existing digest-bound receipt | Page observations cannot identify a person or explain old receipts retroactively |
| Handle keyboard input | Composition, key-code 229, repeat and already-prevented events are guarded in Chat | Real macOS IME and accessibility behavior need separate native acceptance |

Build174's command palette, explicit tool policy, read-only child result, verified parent return and bounded resumable compaction remain part of the baseline. The original local model/provider, loaded-context contract, owner recovery guards and signed data identity remain authoritative.

Noiee already has project chats, local native execution, managed worktrees, Git changes/review, a terminal, Plan/Build, queued follow-ups, steering, fork, skills, connected tools and schedules. Source and fixture coverage are distinct from fresh acceptance of every workflow on this Mac.

## Critical remaining gaps

1. **No demonstrated model-quality parity.** A local Qwen model completing a generated fixture does not establish Astra or Codex-level performance across real repositories. A useful benchmark needs representative projects, identical tasks, source-bound tests, recorded failures and a fixed loaded-model configuration.
2. **Goals are explicitly continued.** Durable objective, criteria, budget, pause/resume and evidence are implemented, but automatic multi-turn pursuit, enforced token budgets and safe scheduling across every owner lifecycle are separate work. Native automatic Goals are disabled on the qualified pinned runtime; changing that runtime requires renewed restoration and idle-continuation qualification.
3. **Verification remains manual.** A model report or zero command exit does not prove relevant tests ran against final source. Verified completion needs command provenance, checked source identity, complete coverage and invalidation after edits. Recorded completion evidence reflects the supplied review.
4. **Fork is not a complete side-chat workflow.** Context return, merging and conflict handling for parallel discussions remain to be built and qualified.
5. **History organization and loading still need work.** Bounded read overlap and visible progress reduce avoidable waiting, but separate owners still open and close serially. No measured native speedup is claimed by source or generated fixtures. Generated acceptance tasks and old startup records can clutter discovery. Retained recovery records must be organized without deleting evidence or weakening owner fences.
6. **Compaction remains bounded and model-written.** Exact retained source and cursors prevent silent history deletion; summaries may still omit important meaning. Partial coverage may reduce no request context yet. The newest exchange stays full and retained metadata has a stated capacity.
7. **The earlier unexpected test submission is unresolved.** Build174 receipt e99c466d-46f4-4636-97d4-3efbe47af4f5 establishes an ordinary request but not its initiating input. Focus interference is plausible and unproven. New observations support future investigation; they do not close that incident.
8. **External services need their own acceptance.** Authenticated publishing, account flows, VM execution and remote effects are separate from generated tests and local native task acceptance. Uncertain effects remain visible.

## Evidence required

Fresh integrated qualification must cover catalog read concurrency bounds, serial owner acquisition and persistence, drained failure/cancellation, global conflict checks, partial/late page replies, exact result navigation and responsive inspector draft/focus retention. It must also cover Goal ownership and revision binding, durable claims, unknown outcomes and no replay, queue/model/workspace/Stop restrictions, attempt budget retention, completion evidence, stored draft failures, malformed/mis-scoped replies, archived inspection and keyboard scope. Submission qualification must cover bounded metadata, canonical digest parity, admission and run-ID binding, legacy byte-preserving reads, IME/repeat behavior and explicit Retry.

An isolated installed-Codex protocol probe must separately check the native Goal restoration fence using a disposable home/project and inert provider. A successful fake `resume` implementation is not proof of the installed runtime's behavior.

Installed native acceptance should exercise saved Tasks loading, the responsive Goal inspector, exact-result navigation, archive feedback and retained drafts across ordinary Quit/reopen. A representative generated task should separately verify ongoing local inference. Build175 separately exercised explicit continuation, pause/resume without work, manual completion, retained drafts and cold reopen without resend. That historical evidence does not replace fresh checks of changed Build176 behavior. New acceptance must preserve the original model and data boundaries and distinguish inherited observations from newly exercised behavior. Only that fresh acceptance report may claim those installed observations passed.
