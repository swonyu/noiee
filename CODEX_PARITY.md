# Noiee: Codex workflow parity target

Reviewed on 2026-11-07 for the Build 174 source. This is an implementation map and critique, not a claim of complete product or model parity. A release must retain separate fresh qualification and installed native-acceptance receipts.

## Baseline

OpenAI describes the Codex harness in terms of persistent threads and turns, tools, approvals, interrupts and streamed events. Its desktop workflows also include project worktrees, review, Queue and Steer, skills, persistent Goals and side chats. An interface built around the harness does not itself establish equivalent model capability or access to managed services.

Primary references:

- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)
- [Mastering Codex remote for engineering](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)
- [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

## What this update improves

| Workflow | Existing foundation | Build 174 scope |
| --- | --- | --- |
| Find the next action | Workspace rail, project panels and Quick actions | Searchable command palette, Cmd+Shift+P and Cmd+J, accessible keyboard selection, current availability and guarded control dispatch |
| Understand tool access | Native Full Access and Ask Before Tools policies | Explicit Chat tools-off and Agent launch-policy labels; unknown and held states remain visible |
| Delegate and inspect results | Native Codex agent families and saved child histories | Read-only child result, immediate verified parent navigation, original Stop control, separate inherited context and own outcome |
| Judge completion | Saved command receipts and model output | Clearly separate execution, model report and unestablished verification; conflicting and failed receipts remain visible |
| Recover long conversations | Manual summary jobs, durable receipts, source hashes and storage CAS | Bounded UTF-8 fragments, honest partial coverage, cold-resumable cursors, encoded carry limits and retained attempt archives |
| Understand old startup failures | Retained owner and native recovery records | Compact counted recovery section; current-task and unrelated live errors remain explicit |

Noiee already has project chats, local native execution, managed worktrees, Git changes/review, a terminal, Plan/Build, queued follow-ups, steering, fork, skills, connected tools and schedules. The presence of their source and fixture coverage is distinct from fresh acceptance of every workflow on this Mac. This update reuses those paths; it does not silently replace the installed engine or provider.

## Critical remaining gaps

1. **No demonstrated model-quality parity.** A local Qwen model completing a small fixture does not establish Astra or Codex-level performance across real repositories. A useful next benchmark needs several representative projects, identical tasks, source-bound tests, recorded failures and a fixed loaded-model configuration.
2. **No first-class persistent Goal lifecycle.** Queued prompts and schedules are useful, but they do not establish a bounded objective with explicit pause, resume, completion and evidence. Goals need a deliberate UI, durable contract and user-visible budget before being advertised.
3. **Fork is not a side-chat workflow.** Existing fork capability does not establish automatic context return, merge semantics or conflict handling for parallel side discussions.
4. **Verification remains manual.** Command exit status alone cannot establish that relevant tests ran against the final source. A future verified-result feature needs command provenance, checked source identity, complete coverage and clear invalidation after edits.
5. **Compaction remains bounded and model-written.** Source retention and exact cursors prevent silent history deletion; they do not guarantee that a summary preserves every important fact. Partial progress may reduce no request context yet. The newest exchange always remains verbatim, and retained metadata eventually reaches a stated capacity limit.
6. **Recovery restrictions remain real.** Retained failed startups, uncertain ownership, fresh-boot recovery requirements and unverified external effects cannot be fixed by clearing markers or making a banner disappear.
7. **External services require their own acceptance.** Authenticated publishing, provider/account flows, VM execution and remote effects are separate from generated browser tests and local task acceptance.

## Evidence needed for this release

Fresh integrated qualification must exercise the palette, focus and dialog isolation; draft/history preservation; disabled and stale controls; Chat/Agent authority; parent/child navigation and inheritance; receipt conflicts; multibyte and escaped compaction input; partial and stale cursors; interrupted recovery; legacy summaries; attempt archives and their count/byte limits.

Installed native acceptance should independently observe the changed workflows, run a generated oversized exchange through partial compaction, preserve an unsent draft, Quit normally, verify physical shutdown, reopen, and continue from saved progress. Only the resulting native receipt may claim that those installed observations passed. Compiler and generated browser checks are not a substitute.
