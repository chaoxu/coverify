# Coverify Philosophy

This document records the stable principles behind the Coverify design. It
should stay short. Operational checklists belong in prompts; API contracts and
workflow mechanics belong in [design.md](design.md).

## Motivation

Strong language models can sometimes solve mathematical problems in one shot:
ask for a proof, and the answer is correct enough to review. Coverify exists
for the harder cases where that does not happen.

The harness is built around a different bet: some problems may be solvable by a
sequence of attempts even when no single attempt has enough time, context, or
luck to finish. A run might try a proof route, find a counterexample to an
invariant, discover that a source theorem has the wrong scope, extract a small
finite certificate, or clarify the next useful lemma. None of those is the
final proof, but each can make the next attempt less blind.

This only works if attempts accumulate as knowledge. A hundred attempts that
all retry the same false invariant are not a hundred units of progress. They
are one attempt repeated a hundred times. The point of the harness is to turn
many short mathematical attempts into directed exploration: keep what was
learned, review what should be trusted, make failed routes searchable, and
force retries to be materially different.

Coverify is therefore both a general mathematical exploration tool and a
memory system for many-shot proof search. It should help a runner ask better
next questions, avoid stale dead ends, and promote useful partial results into
a shared knowledge base.

Longer term, this can support richer proof programs: dependent issues, route
graphs, frontier lemmas, proof obligations, and review queues. Those mechanisms
should grow from the same core idea rather than from premature workflow
machinery: durable, reviewed knowledge should make the next attempt smarter.
The default should remain light: trust the orchestrator to read, select, and
compose context, then use review and verification to catch bad choices.

## Principles

### Many-Shot Progress Over One-Shot Hope

One-shot proof attempts are useful when they work, but the harness should not
depend on them. It should make repeated attempts compound by recording what
each attempt learned and by shaping the next attempt around that knowledge.

### Durable State Over Local Memory

If future humans or agents need something after the current process exits, it
belongs in Cosheaf. Local files, audit bundles, and terminal output are useful
while a run is active, but they are not the project memory.

### Knowledge Is Topic-Shaped

The knowledge base should read like a wiki. Pages should be named for topics a
person would search for, not for artifact roles such as evidence,
obstructions, frontiers, or results. Those roles can appear as sections inside
the relevant topic.

### Light Structure Over Workflow Bureaucracy

The system should not require formal categories, taxonomies, or state machines
unless they solve a real repeated failure. Most mathematical state can be
written directly as normal wiki text. The harness should nudge the orchestrator
with prompts, skills, and conventions, then rely on verifiers and reviewers to
check whether the resulting choices make sense.

Context building is an orchestrator responsibility. A context pack is a
temporary working excerpt for one run, oracle call, review, or edit; it is not
the source of truth and should not become a second knowledge base.

### Negative Knowledge Counts

A failed route is knowledge when it changes what future work should do. A
rejected invariant, a scoped impossibility result, a small counterexample, or a
bounded certificate can be as valuable as a positive theorem if it prevents
repetition.

Negative knowledge is worth promoting only when it is precise: it says what was
tried, why it failed, what evidence supports the failure, what remains open,
and what would make a retry materially different. It does not need a formal
failure class; normal mathematical prose is usually the right format.

### Raw Output Is Not Knowledge

Large generated Markdown files, transcripts, floating-point dumps, and raw
oracle answers are not durable knowledge. They should be distilled into compact
claims, tables, pseudocode, certificates, source notes, or failed-route notes.

### Review Separates Belief From Coordination

Issues and comments coordinate live work. Accepted knowledge requires a merged
page and review appropriate to the claim. Issue comments may point to useful
evidence, but they should not become mathematical evidence merely because they
are durable.

### Progress Means State Change

A run has made durable progress when it changes accepted knowledge, opens a
reviewable PR, records a precise obstruction, receives concrete review
feedback, decomposes an issue, or closes a route with evidence. A long search
or a long explanation is not progress by itself.

### Retry Requires Novelty

A route that has failed should be retried only with a new lemma, weaker
hypothesis, stronger source theorem, better witness family, smaller
counterexample target, or new certificate shape. Otherwise the system is
repeating work, even if the prose looks different.

## Consequences

- A failed proof attempt should be treated as data for future attempts, not as
  disposable chat history.
- Issue comments are the right place for live state; topic pages are the right
  place for reviewed knowledge.
- Failed routes should be promoted into topic pages when they are precise
  enough to guide future work.
- "Things tried" should be a convention inside the relevant topic page, not a
  separate required artifact class.
- Context packs should normally be generated on demand by the orchestrator or a
  context-building skill, then discarded unless the summary itself should
  become a wiki edit or issue/PR comment.
- Searches should answer named mathematical questions and return small
  witnesses, certificates, or counterexamples.
- Cleanup should prefer fewer, clearer topic pages over bucket-shaped files.
- More structure, such as dependent issues or route graphs, is useful only when
  it helps future attempts start from what is already known.
- Prompts should operationalize these principles, not duplicate the entire
  architecture contract.
