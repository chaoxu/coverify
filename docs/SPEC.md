# autoprover draft spec

## Goal

`autoprover` is an automated mathematical exploration harness.

Given a mathematical prompt, it should explore possible statements, proofs,
counterexamples, and dependencies. It writes human-readable Coflat Markdown
documents, extracts statement metadata, records human verification, and uses the
accumulated corpus as memory for later exploration.

The first version is natural-language-first. Formalization is not a core
component. A formal proof, if available, is just one kind of verification
evidence.

## Core Loop

```text
knowledge maintenance updates the current state
  -> scheduler chooses an open statement or prompt
  -> knowledge update agent explores/proves/disproves it
  -> write a separate attempt document
  -> human verifier reviews the result
  -> update statement index and confidence
  -> scheduler chooses the next target
```

The loop may be interrupted by a human at review points.

## Document Format

The source-of-truth corpus is Coflat Markdown, following:

```text
/Users/chaoxu/playground/coflat/FORMAT.md
```

Documents should be readable by humans. They should explain the story of an
exploration: question, attempts, useful statements, failed paths, verifier
feedback, conclusions, and next steps.

`autoprover` adds one convention on top of Coflat. Statement IDs should be
human-readable:

```markdown
::: {.statement #stmt:finite-flat-main confidence="0.35"}
Every object with property $P$ has property $Q$.
:::
```

Statements use stable IDs and ordinary Coflat cross-references:

```markdown
The argument uses [@stmt:finite-flat-helper].
```

## Statement Index

Statements are an index over the document corpus, not a separate source of
truth.

Minimal statement fields:

```text
id
text
document
anchor
confidence
depends_on
support
```

`document` and `anchor` point back to the Coflat Markdown location.

## Confidence

Statements should not pretend to have a final truth value too early.

Each statement has a confidence value derived from human reviews and available
evidence. More independent reviews should usually increase confidence, but
humans can still be wrong, so the record must preserve who reviewed what and
why.

Useful coarse states can be derived from confidence and evidence:

```text
open
supported
high_confidence
disputed
refuted
```

`refuted` requires a reviewed counterexample or contradiction, not merely a
failed proof.

## Prover, Verifier, and Scheduler

The prover proposes:

```text
proof attempts
helper statements
examples
counterexamples
revisions to existing statements
```

For v1, the verifier is human. There is no LLM verifier. LLMs may produce
attempts, summaries, or proposed checks, but their judgment is not verification.

Human verification records:

```text
reviewer
verdict
reasoning
confidence_delta
timestamp
```

Verifier verdicts:

```text
supports
rejects_proof
valid_counterexample
rejects_counterexample
unsure
```

The scheduler looks at the current knowledge state and chooses what to process
next. It may prioritize open statements, disputed statements, dependencies of
important statements, or prompts selected by a human.

## RAG

There is one RAG system over the corpus.

It retrieves document chunks and statement records together. Retrieved items
must carry confidence and provenance, so the agent knows whether it is reading
high-confidence knowledge, open work, failed attempts, or refutations.

External systems such as Matlas can be used as outside retrieval sources, but
local discoveries must be stored in the local corpus.

## Attempt Documents

Proof attempts and failed paths are separate Coflat Markdown documents.

They are useful because they explain what has already been tried and why it did
or did not work. A failed proof does not refute a statement unless the verifier
also validates a counterexample or contradiction.

Successful exposition and failed attempts should be distinguishable in the
corpus. An attempt document may later feed into a polished document, but it
should remain readable as a record of what happened.

## Components

The system is split into two core components:

```text
Knowledge maintenance
Knowledge updates
```

Knowledge maintenance owns the current state:

```text
document corpus
statement index
dependencies
confidence
human reviews
RAG index
```

Knowledge updates run bounded work on a target statement or prompt:

```text
retrieve context
explore or attempt proof/disproof
create helper statements if needed
write attempt document
request human verification
write results back to the corpus/index
```

The scheduler coordinates knowledge updates based on the maintained state.

## Human Interaction

Humans should be able to:

```text
edit documents
approve or reject verifier judgments
adjust confidence through review
ask the system to continue from a specific statement
correct statement text, dependencies, or confidence
```

After human edits, the statement index should be regenerated from the document
corpus.

## Non-Goals for v1

```text
Gitea integration
PR or issue automation
mandatory Lean 4 formalization
LLM verifier as source of verification
multiple document formats
separate trusted and working RAG systems
large database-first knowledge graph
```

## MVP

The first useful command should be:

```text
autoprover explore "mathematical prompt"
```

It should produce:

```text
one Coflat Markdown document
statement blocks with stable IDs
separate attempt documents
human verifier records
an updated statement index
confidence metadata
suggested next targets
```

The first implementation should optimize for fast iteration over real math
problems, not for complete automation.
