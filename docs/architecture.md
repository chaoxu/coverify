# Architecture

Autoprover is a thin client and prompt harness around Cosheaf.

```text
Cosheaf
  source of truth for documents, proposals, reviews, approvals, status

Autoprover
  reads Cosheaf context
  runs local agent commands
  writes Coflat Markdown back to Cosheaf
```

## Roles

An explorer command writes mathematical documents. Its output is Coflat
Markdown body text. Autoprover stores that output as either a new page or a
proposal.

A verifier command reads one target document and returns a small line protocol
(`DECISION`, `COMMENT`, `BODY`) plus a long-form review body. Autoprover creates
a Cosheaf review document and attaches that review to the approval or rejection
row.

## Trust

Autoprover does not decide what is golden. Cosheaf owns the approval threshold
and document lifecycle.

Autoprover only submits decisions as the authenticated Cosheaf user. If that
user is a verifier and enough required verifiers approve, Cosheaf promotes the
document.

## Context

V0 retrieves context through Cosheaf FTS search. This is deliberately simple.
Later versions can add richer retrieval, theorem dependency extraction, and
proof-state memory without changing Cosheaf's document model.

## AI Co-Mathematician Reference

Design decisions should be compared against the best practices in:

```text
AI Co-Mathematician: Accelerating Mathematicians with Agentic AI
arXiv:2605.06651
https://arxiv.org/abs/2605.06651
```

The paper describes an asynchronous, stateful mathematical workspace that
manages uncertainty, refines user intent, tracks failed hypotheses, and emits
native mathematical artifacts. Those are the right defaults for autoprover.

When choosing between designs, prefer the option that better supports:

- persistent workspace state rather than transient chat
- native mathematical documents rather than opaque agent memory
- asynchronous exploration and review
- preserved failed attempts and rejected hypotheses
- user steering at the project/workstream level
- auditable reviewer reasoning

V0 is much smaller than that system, but it should grow in that direction.
