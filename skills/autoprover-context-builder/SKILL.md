---
name: autoprover-context-builder
description: Build concise task-specific Autoprover context from Cosheaf wiki pages, issues, PRs, reviews, tried routes, and raw artifacts. Use before mathematical exploration, oracle calls, PR review, KB writing, cleanup, or any route proposal that must avoid repeating prior failed work.
---

# Autoprover Context Builder

## Purpose

Build a compact working excerpt for one task. A context pack is temporary; the
source of truth is the Cosheaf wiki plus live issues, PRs, reviews, and accepted
documents.

## Workflow

1. Restate the exact task and output target: agent work, oracle call, review,
   PR writing, issue planning, or cleanup.
2. Find the topic page or pages a human would search first.
3. Read accepted claims, definitions, examples, computations, and source notes
   from those pages.
4. Check nearby "Things Tried", "Tried Routes", "Dead Ends", or equivalent
   sections. Also check relevant open and recently closed issues/PRs when
   repeated work is a risk.
5. Include only raw artifacts needed for the immediate task. Summarize bulky
   outputs into claims, pseudocode, commands, or small tables.
6. Write the context in the response, prompt, PR body, or issue body. Do not
   create a durable context file unless the summary itself should become wiki
   knowledge or coordination state.

## Lightweight Shape

Use only the headings that help:

```text
Task:
Accepted context:
Things tried:
Open possibilities:
Live artifacts:
Output needed:
```

## Retry Guard

Before proposing a route, say either:

- no close prior route was found, or
- the closest tried route was `<name/section/link>`, and the new route is
  materially different because of `<new lemma/source/witness/certificate/scope>`.

Do not invent a failure taxonomy. Explain in normal mathematical prose what
was tried, what broke, what evidence supports that, what remains possible, and
what would justify retrying it.
