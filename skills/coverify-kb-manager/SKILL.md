---
name: coverify-kb-manager
description: Clean up and consolidate an Coverify Cosheaf wiki and related route artifacts. Use for topic-shaped KB maintenance, large or narrow cleanup PRs, deleting bulky generated Markdown or exploratory code residue, merging duplicate notes, repairing links, and making future mathematical runs easier.
---

# Coverify KB Manager

## Purpose

Improve the accepted knowledge base itself without adding new mathematics.
Prefer a smaller, clearer wiki over preserving old file boundaries.

Cleanup decisions are agentic. Use tools for stable checks such as broken
links, duplicated files, generated artifacts, and reproducible commands; do not
add deterministic planner code to decide topic structure unless the rule is
mechanical.

## Workflow

1. Use `$coverify-context-builder` to read the current tree, canonical topic
   pages, open issues/PRs, and recent review objections.
2. Decide scope: narrow fix, topic consolidation, large cleanup, or complete
   rewrite.
3. Keep a flat wiki. Pages are topics a human would search for, not buckets
   named evidence, obstruction, frontier, or result.
4. Merge tiny fragments into topic pages when possible. Split only when the
   child topic would be searched or cited independently.
5. Delete or retire bulky generated Markdown after distilling useful claims,
   pseudocode, commands, or small result tables.
6. Preserve useful "things tried" notes in the relevant topic page.
7. Audit exploratory code and helper branches. Keep scripts only when they
   reproduce an accepted KB claim or active issue check with a named question,
   compact command, compact output, and clear owner. Delete, close, or leave
   off main one-off route scaffolds after distilling their result.
8. Produce a reviewable PR with a migration map, correctness-relevant changes,
   issue/PR update plan, and live-check result.

## Output

```text
DOCUMENT_MAP:
PROPOSED_INDEX:
PAGE_BREAKDOWN:
PROBLEMS_FOUND:
THINGS_TRIED_AUDIT:
SCRIPT_RETENTION_AUDIT:
CLEANUP_PLAN:
DOCUMENT_REDUCTION:
ISSUE_UPDATES:
CORRECTNESS_RELEVANT_CHANGES:
REVIEWER_CHECKLIST:
LIVE_CHECK:
PR_SIZE:
```

## Fit Check

A good cleanup has topic-named pages, fewer bucket-shaped files, no local-only
evidence paths, no bulky generated payloads, no unexplained exploratory code,
and a live tree whose files can be explained in one sentence each.
