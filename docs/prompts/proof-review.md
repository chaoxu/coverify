# Correctness Review Prompt

The durable operational entry point is
[`coverify-proof-review`](../../skills/coverify-proof-review/SKILL.md).

Use that skill when a Cosheaf PR proposes correctness-relevant mathematical
knowledge and needs an approve, request-changes, or comment decision.

Correctness judgment belongs to the reviewer/oracle. Harness code may validate
schemas, cited ranges, and reproducible checks, but should not become the
mathematical reviewer.

This file is a compatibility shim for older docs and PRs.
