---
name: coverify-kb-writer
description: Convert useful Coverify source material into compact Cosheaf wiki or PR content without adding new mathematics. Use for oracle output, checked calculations, failed routes, source notes, status notes, exploratory scripts, and other material that should become durable knowledge.
---

# Coverify KB Writer

## Purpose

Distill useful material into wiki-shaped Coflat Markdown. This is artifact
preparation, not proof search and not correctness review.

## Workflow

1. Identify the target topic page. Create a new page only if the topic would be
   searched or cited independently.
2. Preserve source meaning. Do not add stronger claims, hidden assumptions, or
   new references.
3. Keep durable output compact: claims, small tables, pseudocode, command
   summaries, source notes, examples, or "things tried" notes.
4. Keep raw oracle text, local scratch paths, `.coverify` artifacts, long
   transcripts, exploratory scripts, and exhaustive dumps out of accepted prose.
5. Put citeable definitions, theorem-like statements, examples, obstructions,
   and source-backed facts into Coflat semantic blocks with stable ids when
   useful.
6. Link accepted pages or block ids as mathematical evidence. Link issues and
   PRs only as workflow pointers.
7. Mark correctness-relevant claims for `$coverify-proof-review`.

## Failed Routes

Record a failed route when it prevents repeated work. Write normal prose, a
compact table row, or a short remark that says:

- what was tried,
- why it failed,
- what evidence supports the failure,
- what remains possible,
- what would make a retry materially new.

Do not require a formal failure taxonomy.

## Exploratory Code

Treat exploratory scripts and one-off checkers as artifacts, not knowledge. Do
not promote code just because it ran. A script is worth keeping or citing only
when it answers a named yes/no question, has a compact command and output, is
referenced by accepted KB or an active issue, and prevents a likely repeated
failure.

When a computation is useful but the script is not durable, distill it into
pseudocode, a small result table, the exact witness, and the retry condition.
Delete the scratch file or keep it off main after the distilled note exists.

## Output

```text
PROPOSED_FILES:
PAGE_DECISION:
CLAIM_MAP:
TRUST_WORDING:
THINGS_TRIED:
INTERNAL_LINKS:
WORKFLOW_LINKS:
DROPPED_OR_UNCERTAIN_MATERIAL:
SCRIPT_RETENTION_DECISION:
REVIEWER_CHECKLIST:
LIVE_CHECK_EXPECTATION:
```
