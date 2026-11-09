---
name: patch-verify
description: Use when changing project code and reporting whether the requested behavior was verified.
---
# Patch and verify

Work in this task's selected project with its available tools and current permissions.

1. Read applicable project instructions, the affected flow, and every caller of the shared function being changed. Inspect existing edits before writing.
2. Reuse the existing helper, standard library, native feature, or installed dependency that solves the actual problem. Patch the root cause and preserve unrelated work.
3. For nontrivial logic, retain one small runnable check that demonstrates the failure and the corrected behavior. Use the project's existing checks when they cover the change. Avoid tests that merely repeat the implementation.
4. Inspect the final diff and the requested target result. A command receipt proves the command ran; exit zero alone does not prove the whole task succeeded.
5. Report the changed absolute file paths, the exact check and observed outcome, and the remaining gate. Distinguish source changes, built artifacts, installed behavior, saved data, and external effects.

If a tool times out after dispatch, inspect its target before any repeat. Keep existing chats, drafts, owner identities, backups, and recovery restrictions intact. This text grants no additional access and installs no tools.
