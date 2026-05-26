---
name: autoprover-kb-writer
description: Convert useful Autoprover source material into compact Cosheaf wiki or PR content without adding new mathematics. Use for oracle output, checked calculations, failed routes, source notes, status notes, and other material that should become durable knowledge.
---

# Autoprover KB Writer

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
4. Keep raw oracle text, local scratch paths, `.autoprover` artifacts, long
   transcripts, and exhaustive dumps out of accepted prose.
5. Put citeable definitions, theorem-like statements, examples, obstructions,
   and source-backed facts into Coflat semantic blocks with stable ids when
   useful.
6. Link accepted pages or block ids as mathematical evidence. Link issues and
   PRs only as workflow pointers.
7. Mark correctness-relevant claims for `$autoprover-proof-review`.

## Failed Routes

Record a failed route when it prevents repeated work. Write normal prose, a
compact table row, or a short remark that says:

- what was tried,
- why it failed,
- what evidence supports the failure,
- what remains possible,
- what would make a retry materially new.

Do not require a formal failure taxonomy.

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
REVIEWER_CHECKLIST:
LIVE_CHECK_EXPECTATION:
```
