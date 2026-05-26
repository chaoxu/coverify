# Proof Attempt Oracle Prompt

Use this prompt for a strong text-in/text-out oracle when the runner has a
single well-defined mathematical problem and wants a proof attempt,
disproof attempt, obstruction, or key reasoning step without tool use or
internet search.

This is not an agent prompt. The oracle should not browse, inspect Cosheaf, run
code, create artifacts, or manage workflow state. A tool-using runner prepares
the context and later decides what parts, if any, should become a Cosheaf PR.

## Inputs

```text
PROBLEM:
<exact problem statement>

ALLOWED_CONTEXT:
<accepted definitions, lemmas, notation, and hypotheses, or empty>

OUTPUT_TARGET:
<proof, disproof, obstruction, or either proof/disproof>
```

## Prompt

```text
Don't search the internet. This is a test to see how well you can craft a
non-trivial, novel, and creative proof.

Provide a full unconditional proof or disproof of the problem.

Problem:
{PROBLEM}

Allowed context:
{ALLOWED_CONTEXT}

Output target:
{OUTPUT_TARGET}

Requirements:
- Use only the problem statement and allowed context.
- Do not assume extra hypotheses.
- Do not change the problem.
- Write clear mathematical prose. Do not optimize for repository formatting;
  a separate knowledge-base writer will convert useful output into Coflat
  Markdown before it becomes a PR.
- If proving the statement, give a complete argument.
- If disproving the statement, give a complete counterexample or contradiction
  to the claimed statement.
- If you cannot complete the proof or disproof, say so explicitly and provide
  the strongest partial progress, obstruction, or reduction you can justify.
- Distinguish clearly between proved claims, plausible strategies, and
  unverified ideas.

REMEMBER - this unconditional argument may require non-trivial, creative, and
novel elements.
```

## Expected Output Shape

The oracle output is free-form mathematical writing, but it should be easy for
a runner to turn into a PR or a review request. Prefer this structure when
possible:

```text
CLAIM:

PROOF_OR_DISPROOF:

KEY_IDEA:

NONTRIVIAL_DEPENDENCIES:

UNRESOLVED_GAPS:

CHECKS_FOR_REVIEWER:
```

## Artifact Effects

Raw oracle output is not accepted knowledge. It may become:

- a proposed proof PR
- a proposed obstruction or dead-end note
- context for another oracle call
- a PR comment explaining why the attempt was not useful

Anything durable must pass through the normal Cosheaf review gate before being
merged.

The runner should not replace this oracle with its own mathematical reasoning
when an oracle call is available. Runner reasoning is for context preparation,
artifact packaging, and deciding whether the oracle output is worth proposing
as a PR or recording as a failed attempt.
