# Prover-Side Failure Modes And Mitigations

This note is about using a language model as a mathematical prover: give it a
problem, definitions, known results, examples, or candidate lemmas, and ask it
to produce a proof, counterexample, reduction, certificate idea, or obstruction.

If the prover were strong enough, much of the surrounding harness would matter
less. A reliable prover should follow instructions, read the supplied material,
prove the exact target statement, check the hypotheses it uses, and mark
uncertainty honestly. Even a manual workflow works reasonably well if the prover
actually obeys that contract.

Current LLM provers do not obey it reliably. Their failures are predictable, and
many can be reduced by tightening the prompt or the invocation protocol. They
cannot all be eliminated by prompting alone.

## General Contract

Do not treat proof-shaped prose as proof. A good prover invocation should ask
the model to:

- Restate the target theorem exactly, including hypotheses and conclusion.
- Identify and expand the hardest original step.
- Use only the supplied knowledge base or supplied sources by default.
- Attach exact source statements and applicability checks to every cited result.
- Mark every auxiliary lemma as proved, cited, pending, conjectural, or failed.
- Search for counterexamples or boundary cases when the claim is fragile.
- Say explicitly when a proof is incomplete and where it is stuck.
- Avoid presenting computations, examples, diagrams, or retrieval hits as a
  complete proof.

## Failure Table

| Failure mode | Symptom | Mitigation | Can prompting fix it? |
| --- | --- | --- | --- |
| Proves a nearby statement | The proof strengthens assumptions, weakens the conclusion, handles only a special case, or formalizes an easier theorem. | Require "original target / statement I prove / exact match?" before and after the proof. | Prompting helps a lot, but complex formalization still needs an external check. |
| Hallucinates facts or citations | The prover invents papers, theorem names, numbers, URLs, or theorem statements. | Disable web search by default. Allow only supplied sources. Require exact source statements and locations. Missing results must be labeled as conjectural or remembered background. | Prompting and source restriction reduce this strongly, but do not eliminate it. |
| Misuses a real theorem | The source exists, but its hypotheses, definitions, terminology, or scope do not match the current problem. | Require a source-hypothesis checklist and a current-problem-hypothesis checklist for each cited theorem. | Prompting helps; expert or independent review is still needed for hard domains. |
| Skips the hard step | Routine parts are detailed, while the core difficulty is hidden behind words like "standard", "clear", or "straightforward". | Require the prover to name the hardest step first, ban vague step-closing phrases, and expand that step subclaim by subclaim. | Often helps, but the model can still fake detail. |
| Moves the gap into a helper lemma | The proof introduces a lemma that is as hard as the theorem, unproved, false, or equivalent to the original problem. | Require every helper lemma to state its proof status, dependencies, and why it is easier or independently sourced. | Helps, but judging equivalence or true difficulty may require review. |
| Drifts between proof strategies | The proof starts with one plan, switches plans, drops dependencies, or combines incompatible arguments. | Ask for a numbered proof plan and require every proof paragraph to cite the plan step it closes. If the plan changes, the prover must say why. | Prompting can significantly improve this. |
| Treats retrieval as proof | The prover finds a relevant-looking paper or theorem and treats it as applicable without checking conditions. | Separate retrieved material, usable theorem, and verified-applicable theorem. Require applicability checks before use. | Prompting helps if source quality is good. |
| Fails to search for counterexamples | The claim is fragile, but the prover keeps trying to prove it instead of testing small, boundary, or degenerate cases. | Frame tasks as "prove or refute". Require sanity checks, small cases, and boundary cases before a proof attempt. | Very effective in early exploration. |
| Repeats a failed route | A later attempt uses new prose but relies on the same bad invariant, reduction, or missing lemma. | Feed the failed route back explicitly and forbid reuse unless there is a new lemma, assumption, or counterexample analysis. | Needs prior failure history; a single prompt cannot fix it. |
| Confuses evidence with proof | Computations, examples, diagrams, numerical checks, or search results are written as if they prove the theorem. | Require labels: proof, evidence, experiment, conjecture. Computation proves only when paired with a checkable certificate or exhaustive argument. | Prompting helps; full resolution needs a certificate or independent verification. |
| Overstates certainty | A plausible sketch is presented as a complete proof; unresolved steps are hidden. | Require status labels such as proved, plausible, gap, needs verification, or counterexample found. Reward honest failure. | Helps, but the model may still over-polish. |
| Produces hard-to-check output | Statements are ambiguous, notation drifts, dependencies are implicit, or sources are vague. | Require a fixed structure: statement, definitions, dependencies, proof, hard step, open gaps, sources. | Prompting can improve this substantially. |
| Locally plausible but globally incomplete | Individual paragraphs look right, but not all cases, branches, or subgoals are closed. | Require a complete case split or subgoal list, status for every subgoal, and a final coverage check. | Helps, but complex proofs still need verification. |
| Misses boundary cases | The proof handles the generic case but skips empty, zero, equality, extreme-parameter, or degenerate cases. | Require an explicit boundary-case list and a sentence closing each case. | Usually prompt-addressable. |
| Notation or definition drift | The same symbol changes meaning, or a source term is imported with the wrong local definition. | Require a notation table and source-to-current terminology mapping. | Helps, but long proofs still drift. |
| Does not know when to stop | The prover keeps writing irrelevant material or invents a path after getting stuck. | Set output budgets and stop conditions. If the core step is unresolved, it must stop and report the gap. | Prompting helps. |

## What Prompting Can And Cannot Fix

### Mostly Prompt-Fixable

- Hard-to-check output.
- Missing hypothesis/conclusion lists.
- Missing helper-lemma status.
- Missing boundary cases.
- Failure to distinguish proof, evidence, and conjecture.
- Failure to try counterexamples.

These are often failures of the proof contract. Clearer output format and
required checks help substantially.

### Needs A Stronger Invocation Protocol

- Repeating failed routes.
- Proof-plan drift.
- Skipping the core step.
- Locally plausible but globally incomplete arguments.

These are not just wording problems. They often need staged calls: plan first,
then prove; search for counterexamples before proving; list subgoals before
closing them; feed failed routes back into the next attempt.

### Not Solved By Prompting Alone

- Whether a citation really exists.
- Whether a cited theorem really applies.
- Whether a helper lemma is equivalent to the original target.
- Whether a computation is reproducible.
- Whether a formal statement faithfully represents the informal theorem.
- Whether a long proof is actually gap-free.

Prompts can reduce the error rate, but these require source checks,
computational checks, formal checks, independent review, or a separate verifier.

## Minimal Prover Prompt Template

```text
You are a mathematical prover, not a writing assistant.

Task:
1. Restate the theorem to prove or refute exactly.
2. List all assumptions, definitions, and conclusions.
3. If the claim may be false, search first for counterexamples and boundary cases.
4. Use only the supplied sources unless explicitly told otherwise.
5. If you use an external theorem, give:
   - the exact theorem statement;
   - the source location;
   - why every hypothesis holds here.
6. Give a proof plan and identify the hardest original step.
7. Expand the hardest step. Do not hide key reasoning behind "clear",
   "standard", or "straightforward".
8. Mark every auxiliary lemma as proved, cited, pending, conjectural, or failed.
9. After the proof, check:
   - Did you prove the original theorem rather than a nearby theorem?
   - Are all cases covered?
   - Do all cited results satisfy their hypotheses?
   - Are any gaps still open?
10. If you cannot complete the proof, state the failure point directly. Do not
    package a sketch as a complete proof.
```

## Bottom Line

A prover should be evaluated by contract-following, not fluency.

A reliable prover must:

- prove the exact statement;
- expose and solve the hard step;
- use sources correctly;
- search for counterexamples and boundary cases when appropriate;
- avoid presenting evidence as proof;
- surface gaps honestly;
- explain failure points when it cannot finish.

If the prover cannot do these things, a surrounding system can reduce risk, but
it cannot make the proof itself automatically reliable.
