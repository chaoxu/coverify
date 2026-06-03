# Knowledge-Base Manager Prompt

The durable operational entry point is
[`coverify-kb-manager`](../../skills/coverify-kb-manager/SKILL.md).

Use that skill for topic-shaped KB cleanup, consolidation, deleting bulky
generated Markdown, merging duplicate notes, repairing links, and making future
runs easier.

Cleanup planning is agentic; code should only enforce stable mechanics such as
link checks, path validation, or repeatable generated-file cleanup.
Cleanup must preserve acceptance status separately from resolution artifact
type. Accepted knowledge, proposed claims, speculation, unresolved gaps, and
failed routes should not be blurred together; artifact vocabulary is owned by
`src/coverify/math_contract.py`.

This file is a compatibility shim for older docs and PRs.
