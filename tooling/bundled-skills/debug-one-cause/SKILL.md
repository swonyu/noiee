---
name: debug-one-cause
description: Use when a bug, unexpected result, timeout, or regression needs a bounded root-cause investigation.
---
# Debug one cause

Start with the exact failing input and observed error. Record the relevant project, selected model, provider, and source revision when those affect reproduction. Historical success is not current evidence.

1. Reproduce with the smallest safe fixture and state the expected postcondition. If reproduction is unavailable, identify the missing observation before changing code.
2. Trace the full data path and shared callers. Compare one working case with one failing case and state one evidence-backed hypothesis.
3. Change one cause at its shared boundary. Reuse existing code. Inspect partial effects before repeating a failed command; a timeout can hide a completed action.
4. Run one focused check of the original failure and the nearest meaningful edge case. Inspect the actual output and retain the check when the logic is nontrivial.
5. Report the cause, correction, observed checks, and unresolved uncertainty. A passing parser check does not establish installed-app or model quality acceptance.

Preserve the user's files, drafts, owner records, and recovery evidence. Do not substitute models, clear a ledger, grant permissions, or perform broad cleanup to make a reproduction pass. Existing task authorization still controls actions.
