# References And Future Notes

This document records papers and external ideas that influence the design. It
is not a benchmark leaderboard and not a commitment to copy any system
architecture.

## Doc Map

- [README](../README.md) is the repository entry point.
- [Coverify Design](design.md) is the canonical contract these references
  feed into.
- [Research-Agent Paper Deep Dives](reference-deep-dives.md) gives the
  stronger paper-by-paper account of each system's workflow, trust model,
  reported evidence, and implications for Coverify.
- [LLM Math Failure Modes](llm-math-failure-modes.md) consolidates the
  paper-reported and Coverify-observed failure modes that should drive prompts,
  verifier gates, output contracts, and evals; it also links the shareable
  prover-side note.
- [Experiments](experiments.md) turns these design lessons into measurable
  comparisons.
- [Skills](../skills) are the durable operational interface for review,
  attempts, planning, writing, cleanup, context building, and the run loop.
- [Prompt Templates](prompts/README.md) keeps compatibility shims for older
  docs and PRs; operational behavior belongs in skills.
- [Reference Prompt Collection](prompts/reference/README.md) indexes external
  prompt systems and their reusable patterns.
- [Coflat Context Primer](coflat-primer.md) is the local page-format guide for
  any design lesson that affects mathematical document structure.

The standing filter for each reference is:

```text
What should change in our prompts, tools, review gates, or knowledge format?
```

Apply that filter with the agentic-preparation boundary in mind: copy
judgment-heavy behavior into prompts, skills, or oracle calls first; copy only
stable, mechanical checks into Python tools.

## QED

**QED: An Open-Source Multi-Agent System for Generating Mathematical Proofs on
Open Problems**, An et al., arXiv:2604.24021, 2026.

Links:

- Paper: https://arxiv.org/pdf/2604.24021
- Code: https://github.com/proofQED/QED

What matters:

- Research-level proving failures are often system-design failures, not only
  model-quality failures.
- The relevant failure modes are context contamination, citation
  hallucination, hand-waving on key steps, unstable proof plans, unfocused
  verification, problem modification, and single-model bottlenecks.
- Proving and verification should not share private context.
- Verification benefits from structural checks before detailed line-by-line
  checks.
- The prover should identify and expand the hardest original step.
- Problem-statement integrity is a hard check: the proof must solve the
  original problem, not a silently modified version.

Design lessons:

- Review templates should include problem integrity, citation grounding,
  key-step detail, and local logical correctness.
- A reviewer that cannot decide should request changes that make the PR
  decidable.
- For hard proof tasks, Codex can ask for a proof plan before a proof, but the
  plan should become text in PR context, not a private workflow graph.
- Retry feedback should explain in ordinary prose whether the failure came
  from execution, the plan, or the overall strategy when that distinction is
  useful. Do not turn this into a required failure taxonomy.
- Do not copy QED's fixed multi-agent pipeline into the default loop.
- Treat QED's structural review, detailed review, and regulator prompts as
  reference checklists that can enrich the single review prompt or runner
  policy, not as mandatory separate workflow stages.
- Treat QED's planning stages as examples of what an agent or oracle may do
  inside an allowed context, not as a reason to add deterministic planner code
  to the harness.

## AI Co-Mathematician

**AI co-mathematician: Accelerating mathematicians with agentic AI**, Zheng et
al., arXiv:2605.06651, 2026.

Link: https://arxiv.org/abs/2605.06651

What matters:

- Mathematical AI is framed as a workbench for exploratory research, not only
  as a prover that emits final answers.
- The workspace model matches Cosheaf's role: uncertainty, failed hypotheses,
  partial artifacts, and native mathematical outputs need durable places to
  live.
- Human mathematicians currently move by hand between informal reasoning,
  literature, computation, and proof checking.
- Negative knowledge matters. Failed routes, rejected lemmas, and
  problem-statement clarifications should be preserved when they prevent
  repeated work.
- Strong models are useful collaborators, but their outputs still need local
  grounding and correctness review.

Design lessons:

- Cosheaf should be the workbench memory; do not build a second hidden
  workspace.
- Context packs should preserve the original problem, accepted background,
  relevant failed attempts, and exact requested output shape.
- Oracle calls are the default path for mathematical reasoning once an agent
  gathers and filters context. The runner should not substitute its own proof
  judgment when a strong oracle call is available.
- Agentic preparation is the default path for deciding what context matters;
  mechanical validation should check the prepared paths, ranges, citations, and
  artifacts.
- Review should reward refusal and precise obstruction reports as real
  progress, not only completed proofs.
- Do not add a scheduler, learned prioritizer, or multi-agent allocator until
  the single-runner issue/PR loop is proven.

## STAR-PólyaMath

**STAR-PólyaMath: Multi-Agent Reasoning under Persistent Meta-Strategic Supervision**, Wu et al., arXiv:2605.19338, 2026.

Links:

- Paper: https://arxiv.org/abs/2605.19338
- Code: https://github.com/Julius-Woo/STAR-PolyaMath

What matters:

- The paper frames long-horizon math failures as hallucination accumulation, memory fragmentation, and poor reasoning/tool balance.
- The system uses a reasoning-free Python orchestrator with Reasoner, Verifier, and persistent Meta-Strategist roles, plus nested challenge, step, and replan loops.
- The repo describes a self-contained scratch directory with `problem.md`, `plan.md`, `PROBLEM_STATE.md`, `state.json`, per-step reports, verifier notes, debate transcripts, code, archives, and final solution files.
- The authors report strong competition-math results and ablations where removing framework components weakens performance; this is useful evidence but still needs careful reading before it becomes Coverify design.

Design lessons:

- Persistent, visible state files are the most relevant idea for Coverify. They are closer to Codex's working tree than to hidden agent memory.
- A Meta-Strategist role may be a useful prompt pattern for escaping repeated failed routes, but it should first live as agentic guidance or an issue-level artifact, not as default Python orchestration.
- The "reasoning-free orchestrator" boundary matches Coverify's direction: code should move files, validate artifacts, and dispatch calls; mathematical judgment should stay in prompts, tools, and verifiers.
- The challenge/replan loops are worth studying for eval-driven runs, but not copying wholesale into the default chat loop.

## Goedel-Architect

**Goedel-Architect: Streamlining Formal Theorem Proving with Blueprint Generation and Refinement**, Chung et al., arXiv:2606.06468, 2026.

Link: https://arxiv.org/abs/2606.06468

What matters:

- The central artifact is a blueprint: a dependency graph of definitions and lemmas building up to the main theorem.
- The initial blueprint can be seeded by a natural-language proof, then each lemma node is proved independently with only its declared parents.
- Failed nodes produce typed refinement signals: statement wrong, proof too hard, missing or wrong decomposition, counterexample/disproof, or need for helper lemmas.
- Lean is not just a final verifier. It checks statement well-formedness, theorem-signature preservation, dependency graph structure, skeleton validity, proof success, and feedback from compiler/Mathlib/retrieval during each node attempt.

Design lessons:

- A natural-language analogue is worth spiking: require a visible lemma graph with explicit hypotheses, allowed dependencies, proof attempts, verifier objections, and typed failure diagnoses.
- Without Lean, this is not a formal trust gate. It is a structured search and human-time-saving artifact whose accepted nodes still need conservative review.
- The precision target should be "accepted nodes mostly survive human review," not "generated text sounds plausible."
- Do not build a natural-language blueprint engine into Coverify until evals show it beats simpler `prepare-llm`, verifying, and stateful-run baselines.

## Rethlas

**Rethlas**, FrenzyMath, 2026.

Links:

- Code: https://github.com/frenzymath/Rethlas
- Writeup: https://frenzymath.com/blog/conjecture

What matters:

- Rethlas uses a generation agent and a verification agent, with the generator
  repairing proof blueprints until verification passes.
- Its control loop is adaptive: search, toy examples, counterexamples,
  subgoal plans, direct proving, recursive proving, key-failure synthesis, and
  proof verification are chosen based on current state.
- It persists typed intermediate memory: conclusions, examples,
  counterexamples, subgoals, proof steps, failed paths, verification reports,
  and branch states.
- It treats failed paths as mandatory reusable memory.
- It treats search as support for reasoning, not a substitute for reasoning.

Design lessons:

- Keep the useful habit of preserving failed paths and counterexamples.
- Do not copy the full skill taxonomy into the default loop. Most Rethlas
  skills are tactics a runner can choose inside exploration, mathematical
  resolution, or review.
- If a tactic becomes repetitive and brittle, add a thin wrapper later. Until
  then, keep it as prompt guidance or a reference pattern.
- Keep adaptive tactic choice agentic. Do not turn Rethlas-style control flow
  into a hidden deterministic scheduler before the single-runner loop proves it
  needs that machinery.
- Map Rethlas-style typed memory to Cosheaf artifacts instead of creating a
  private memory store.

## Aletheia And Open-Problem Agents

**Towards Autonomous Mathematics Research**, Feng et al., 2026.

Notes surfaced from google-deepmind/superhuman and related Aletheia material:

- Review quality is a bottleneck.
- A system should be rewarded for refusing bad proofs rather than fabricating.
- Long-running mathematical work needs durable memory and resumability.
- External expert review remains expensive and should be protected by strong
  internal review filters.

Specific design ideas:

- **Grader as object**: reviewer or oracle calibration should be measurable.
  Reference solutions, grading guidelines, and calibration results should be
  Cosheaf artifacts, not private harness state.
- **Correctness and significance are separate**: if the harness records grades,
  keep significance separate from correctness. Prefer Cosheaf labels such as
  `sig:*` and `grade:*` before inventing a scoring table.
- **External grounding belongs in context packs**: retrieval should provide
  cited pages, related issues, PR history, reviews, and curated corpus excerpts
  explicitly.
- **Abstention is useful**: if review cannot decide, request changes; if the
  boundary is human, record `needs-human`.
- **Specification drift is a real risk**: context packs should preserve the
  original issue or problem statement separately from any proposed restatement.

## Future Learning

Learning and evaluation are not current requirements. The design should only avoid
closing them off.

If future implementation records traces, they should be derived from or linked
to Cosheaf artifacts:

- triggering issue, branch, PR, review, page, or comment
- context pack sent to Codex or a backend
- backend name and invocation metadata
- raw backend answer or Codex output
- knowledge PR, review, issue comment, or page update created after the run
- whether the related PR merged, changed, closed, or stayed open
- labels such as `grade:*`, `sig:*`, or `needs-human`
- follow-up issue/PR/review ids created from the run

Possible future uses:

- compare context-pack strategies
- decide when to call a stronger backend
- predict which branches or PRs are worth continuing
- calibrate reviewers or oracle backends
- study failed attempts preserved in Cosheaf

Non-goals for the design phase:

- no RL policy
- no learned scheduler
- no hidden long-term model memory
- no trace schema that becomes a second source of truth

## AlphaProof Nexus

**Advancing Mathematics Research with AI-Driven Formal Proof Search**,
Tsoukalas et al., arXiv:2605.22763, 2026.

Links:

- Paper: https://arxiv.org/pdf/2605.22763
- Results: https://github.com/google-deepmind/alphaproof-nexus-results

What it actually does:

- The input is already a Lean proof task: a Lean file with a target theorem,
  imported definitions/libraries, and `sorry` placeholders.
- The agent may edit only marked regions such as `EVOLVE-BLOCK` and
  `EVOLVE-VALUE`.
- The basic agent is a set of independent prover subagents. Each subagent runs
  a multi-turn LLM loop, modifies the Lean sketch with search-and-replace, and
  checks the result with the Lean compiler after each turn.
- If Lean reports errors or open goals, those diagnostics are fed into the next
  episode. If an episode ends with remaining `sorry`, the subagent leaves a
  summary for the next episode.
- A stronger variant can call AlphaProof as a tool on subgoals. AlphaProof may
  return a proof, a disproof of the submitted subgoal, or failure.
- The evolutionary variant keeps a population database of proof sketches.
  Cheaper rater models compare sketches for plausibility, clarity, and novelty;
  the system aggregates those comparisons into Elo scores and samples future
  attempts from this population.
- The full agent combines Lean validation, AlphaProof subgoal calls, and the
  evolutionary population/rating mechanism.
- A candidate is accepted only if a validator confirms the problem statement
  was not changed unsafely and the final Lean proof compiles with all goals
  proved and no `sorry`.

Reported evidence:

- The full-featured agent solved 9 of 353 formalized Erdős problems attempted.
- A basic independent-subagent agent also solved those same 9 in post-hoc
  comparison, but usually at higher cost on harder problems.
- The system proved 44 of 492 autoformalized OEIS conjectures.
- The paper reports several research-level successes and makes public Lean
  proofs for the solved problems.
- They explicitly report failure modes: top sketches often hid the core
  difficulty in helper lemmas with `sorry`, or cited hallucinated literature
  lemmas. This is presented as evidence for end-to-end formal verification.

What is not clear enough to copy:

- The evolutionary database and Elo ratings may help for formal proof search,
  but the paper does not establish that this machinery is better than simpler
  independent attempts on our kind of informal/Cosheaf tasks.
- The success condition depends on having a formal Lean statement. The system
  still needed expert validation that the Lean statement faithfully represented
  the original Erdős conjecture.
- The best evidence is for tasks already expressible as Lean sketches, not for
  free-form knowledge-base exploration.

Design lessons:

- Copy the acceptance contract, not the whole architecture: candidate search is
  cheap; accepted claims require a strong gate.
- For Coverify, an analogous gate could be an exact certificate verifier,
  a formal prover, or an explicitly trusted oracle verifier. Without such a
  gate, the output should remain `proposed`.
- Do not import population databases, Elo raters, or evolutionary sampling
  until evals show that simpler independent attempts are losing on our tasks.
- Problem-statement integrity is a hard requirement. A verifier must check that
  the submitted result proves the original issue, not a nearby easier version.

## Rethlas / Archon Formalization Pipeline

**Automated Conjecture Resolution with Formal Verification**, Ju et al.,
arXiv:2604.03789, 2026.

Links:

- Paper: https://arxiv.org/abs/2604.03789
- Rethlas: https://github.com/frenzymath/Rethlas
- Archon: https://github.com/frenzymath/Archon

What it actually does:

- The full framework has two stages. Rethlas first searches for a candidate
  informal proof. Archon then translates the informal proof into a Lean 4
  project and fills missing formal details.
- Rethlas itself has a generation agent and a verification agent. The generator
  proposes an informal proof; the verifier checks it and returns feedback; the
  generator revises until the verifier passes or the attempt fails.
- The generation agent is prompted with a large tactic inventory: toy examples,
  counterexamples, theorem search, subgoal decomposition, direct proving,
  recursive proving with subagents, and key-failure synthesis.
- Rethlas uses Matlas for theorem retrieval. The paper describes an earlier
  arXiv-statement corpus of about 13.6 million extracted statements, and a
  later curated Matlas corpus of 8.51 million statements from papers and books.
- Rethlas keeps working memory of artifacts such as examples,
  counterexamples, decomposition plans, and intermediate results.
- The verification agent is still a model-based natural-language reviewer. It
  checks skipped steps, gaps, unused assumptions, citation existence, source
  applicability, and terminology shifts.
- Archon is the stronger correctness layer. Given an informal proof, it
  initializes a Lean project, collects dependent references, creates
  topic-specific files, formalizes statements and definitions, fills gaps, and
  iterates until the project compiles.
- Archon uses a Plan Agent in fresh context plus one or more Lean Agents. The
  Plan Agent decomposes and redirects work; Lean Agents execute scoped
  formalization tasks. This separation is meant to reduce context pollution and
  task aversion after many failures.
- Archon can ask a lightweight informal agent or Rethlas for more detailed
  natural-language subproofs or alternative routes when formalization stalls.
- Final checks include successful compilation, no `sorry`, no added axioms or
  escape hatches, and proof-quality cleanup.

Reported evidence:

- Rethlas reportedly found a counterexample proof for Anderson's 2014 weak
  quasi-completeness question after about 45 minutes of autonomous reasoning;
  Archon later formalized the result in Lean 4.
- The paper says Archon produced complete formalizations of two FirstProof
  problems from OpenAI informal proofs: one fully autonomously and one with a
  single natural-language hint.
- For a separate algebraic-group problem, Rethlas with GPT-5.5 generation and
  GPT-5.4 verification produced a correct solution except for a
  citation-substitution issue.
- The paper is evidence that retrieval plus informal search can find useful
  routes, but the authors still use Lean formalization as the trustworthy final
  gate.

What is not clear enough to copy:

- Rethlas is prompt-heavy and tactic-heavy. The paper does not isolate which
  prompts or skills are responsible for success, nor does it show that the full
  taxonomy beats a simpler agentic loop on our domains.
- The model-based Rethlas verifier is not the final guarantee. The durable
  guarantee comes from Archon/Lean.
- Matlas-scale retrieval is a major capability. Copying the prompt structure
  without comparable source retrieval may not reproduce the reported behavior.
- Typed private memory is useful operationally but conflicts with Coverify's
  principle that durable state should live in Cosheaf.

Design lessons:

- Rethlas is best treated as a reference library of tactics, not a workflow to
  clone.
- The Archon lesson is stronger for us than the Rethlas lesson: keep a clean
  split between proposer, planner/reviewer, and verifier; avoid letting failed
  local attempts poison every future context.
- If we replace Lean with our own trusted verifier, the loop still makes sense,
  but the verifier contract must be explicit: exact claim, allowed context,
  source checks, pass/fail reason, and artifact hashes.
- Before adopting Rethlas-style skill taxonomies or recursive subagents, define
  evals where those tactics must outperform a simpler loop.

## Gilbert-Pollak Verification Functions

**Towards Solving the Gilbert-Pollak Conjecture via Large Language Models**,
Ke et al., arXiv:2601.22365, 2026.

Links:

- Paper: https://arxiv.org/abs/2601.22365
- Code and proof: https://github.com/keyisi2006/Steiner-Ratio

What it actually does:

- The target is the Gilbert-Pollak / Steiner Ratio conjecture. The system does
  not ask an LLM to prove the conjecture directly.
- The authors first reformulate lower-bound proving as a minimax feasibility
  problem over splitting functions arising from an inductive pruning argument.
- They introduce **verification functions**: functions satisfying structural
  shape and bounding constraints. These functions upper-bound splitting
  functions and reduce continuous verification on hyperrectangles to finite
  vertex checks.
- A reward model uses binary search over candidate lower bounds and a
  branch-and-bound feasibility oracle over the continuous parameter space.
- The LLM's job is narrowed to generating rule-constrained geometric lemmas as
  executable code snippets. The paper reduces useful verification functions to
  two lemma families: trapped regular point lemmas and valid 4-point Steiner
  tree lemmas.
- The system uses local symbolic/computational tools, especially Mathematica
  `Reduce`, to derive, simplify, and verify candidate constraints before they
  become verification functions.
- A reflection loop identifies bottleneck regions where the current
  verification functions fail to certify the bound, converts those bottlenecks
  into natural-language feedback, and asks the LLM to generate better lemmas.

Reported evidence:

- The system improves the certified lower bound for the Steiner ratio from the
  prior 0.824 to 0.8559, against the conjectured value $\sqrt{3}/2 \approx
  0.866$.
- The paper reports that the iterative refinement took about ten iterations
  and thousands of LLM calls, at a cost of a few hundred dollars.
- The authors provide reproducible code and a simplified proof appendix for
  readers interested only in the mathematical result.

What is not clear enough to copy:

- The success depends on a highly domain-specific mathematical reduction:
  verification functions, vertex maximum properties, and a branch-and-bound
  feasibility oracle. This is not a general-purpose proof architecture.
- The LLM search works because the authors made the search space small and
  executable. Without an analogous reduction for a Coverify problem, copying
  the loop would mostly add machinery.
- The verifier/reward is not a natural-language reviewer; it is a mathematical
  and computational certificate pipeline tailored to this geometry problem.
- Floating or symbolic computation details need independent audit before being
  treated like a formal proof assistant.

Design lessons:

- This is the strongest example here of the "small harness plus hard verifier"
  pattern: the LLM proposes constrained artifacts; local code/symbolic tools
  decide whether they certify progress.
- For Coverify, the analogous move is to look for problem-specific certificate
  languages: LP dual certificates, finite obstruction manifests, exact
  enumerations, branch-and-bound certificates, or source-backed reduction
  lemmas.
- Reward signals should be mathematically meaningful. A scalar score is useful
  only when it is tied to a verifier or certificate, not when it is just an LLM
  preference score.
- Bottleneck-region feedback is worth considering for exact searches: when a
  verifier fails, expose the smallest failing cases or uncovered regions to the
  next oracle call.
- Do not build a generic reflection loop first. Build a concrete certificate
  target and let the failed verifier cases drive reflection.

AutoResearch analogy:

- This is the mathematical version of an AutoResearch keep/discard loop, but
  with a verifier-backed mathematical score instead of a validation-loss metric.
- The outer loop belongs to exploration: read the current project or task
  state, inspect verifier failures, and choose the next candidate artifact.
- The inner task belongs to mathematical resolution or a fixed checker: validate
  one constrained lemma, certificate, reduction, obstruction, or bound update.
- No new Coverify mode is needed. Golden Cosheaf documents can carry project
  orientation, local progress measures when they exist, keep/discard rules, and
  "do not retry" notes. Project-specific checker code can be added later when a
  task actually needs it.
- The golden repo, not Coverify, should name the mathematical objects, local
  scoring rule when one exists, accepted checker, and trial records. External
  symbolic or computational programs are tools referenced by that guidance, not
  new Coverify workflow types.
- Replicating this problem in Coverify alone would mean writing the Gilbert-
  Pollak orientation page, task issues, and any needed checker instructions or
  project-specific checker code in Cosheaf, then using the existing exploration
  and mathematical-resolution contracts. It would not reproduce their result
  unless the domain-specific
  symbolic checker and branch-and-bound verifier are also supplied as trusted
  tools or reviewed artifacts.
