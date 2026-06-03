# Exploration Planner Prompt

The durable operational entry point is
[`coverify-exploration-planner`](../../skills/coverify-exploration-planner/SKILL.md).

Use that skill when exploration needs to inspect current Cosheaf knowledge,
existing issues/PRs, and "things tried" notes before answering directly,
proposing issue-ready routes, or packaging exact mathematical-resolution
targets.

Planning is agentic by default. Do not translate route choice or context
selection into deterministic Python code unless the behavior is already a
stable mechanical check. Any factual or mathematical claim it sends onward
should be source-grounded, verified, or clearly labeled as speculation/gap.

This file is a compatibility shim for older docs and PRs.
