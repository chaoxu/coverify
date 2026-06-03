# Research-Agent Paper Deep Dives

This document is a grounded reading note for mathematical-agent systems that
could influence Coverify. It is not a leaderboard. Each section answers the
same questions:

- What problem is the paper/system trying to solve?
- What is the harness or workflow model?
- What is the verification or acceptance gate?
- How successful was it, by the evidence the authors report?
- What should affect Coverify's design space?

For the consolidated failure-mode checklist extracted from these papers and
from Coverify/Cosheaf repo-chat work, see
[LLM Math Failure Modes](llm-math-failure-modes.md).

The main takeaway is simple: the successful systems do not merely ask a strong
model to write a proof. They narrow the artifact being produced, preserve
state, separate generation from review, and place some kind of hard or
expensive acceptance gate at the end.

## Comparison Snapshot

| System | Primary artifact | Search model | Acceptance gate | Reported evidence | Coverify lesson |
| --- | --- | --- | --- | --- | --- |
| QED | Natural-language proof of an open research problem | Fixed multi-stage prover/reviewer pipeline | Model structural review, model detailed review, then domain experts | 5 of 18 expert-proposed research projects solved; 17 verifier-accepted candidates later accepted by experts | Copy review checks and separation, not the whole fixed pipeline |
| AI co-mathematician | Stateful research workspace and reports | Coordinator with parallel workstreams and specialist agents | AI reviewers plus human mathematicians; benchmark final-answer mode | Case studies with mathematicians; 23/48 on FrontierMath Tier 4 excluding public samples | Copy durable workspace, failed-route memory, and human-facing collaboration model |
| AlphaProof Nexus | Lean proof replacing `sorry` placeholders | Independent LLM subagents, optional AlphaProof, optional evolutionary sketch population | Lean compilation, no `sorry`, SafeVerify, and expert statement-fidelity check | 9/353 formalized Erdos problems; 44/492 OEIS conjectures | Copy hard verifier contract; do not import evolutionary machinery without evals |
| Rethlas / Archon | Informal proof, then Lean 4 project | Rethlas generator/verifier plus retrieval; Archon Plan Agent plus Lean Agents | Rethlas model verifier for candidates; Lean/Comparator for final formalization | Anderson problem resolved and formalized; two FirstProof formalizations; additional informal case studies | Treat tactics as prompt references; the durable lesson is proposer/reviewer/hard gate |
| Gilbert-Pollak LLM system | Domain-specific lower-bound certificate components | LLM proposes constrained geometric lemmas from verifier bottlenecks | Symbolic/computational verification functions and branch-and-bound; human-readable proof | Lower bound improved from 0.824 to 0.8559 | Best model for certificate-search loops: LLM proposes, verifier localizes failures |

## QED

Source: [QED: An Open-Source Multi-Agent System for Generating Mathematical
Proofs on Open Problems](https://arxiv.org/pdf/2604.24021), An et al., 2026.
Code: [proofQED/QED](https://github.com/proofQED/QED).

### What It Is Trying To Do

QED targets open, research-level mathematics problems supplied by domain
experts. The authors are not testing on known-answer contest problems. They
want a system that can take a human-provided research question and produce a
complete natural-language proof without further expert steering during the
run.

The paper is organized around concrete failure modes seen in earlier attempts:
context contamination between prover and verifier, hallucinated citations,
proof effort spent on easy steps while the hard step is skipped, unstable proof
plans, unfocused verification, silent problem modification, and single-model
bottlenecks.

### Harness / Workflow Model

QED is deliberately a multi-stage pipeline.

In simple mode, a round consists of:

1. One or more prover agents generate candidate proofs.
2. A structural verifier checks fatal global issues first.
3. A detailed verifier checks local mathematical correctness.
4. A selector chooses the best proof-verification pair.
5. A verdict agent decides whether the system is done or should continue.

The prover and verifier are separate calls with separate contexts. The verifier
sees the proof document and original problem, not the prover's private chain of
attempts. This is meant to reduce self-verification bias.

For harder problems, QED has a decomposition mode. A decomposer writes a proof
plan as a directed acyclic graph of intermediate mathematical claims, including
dependencies, difficulty, key-step flags, citations, and self-critique. A
single prover then writes a proof following that plan. A regulator reads the
verification failure and decides whether the next move is to revise the proof,
revise the plan, or abandon the strategy and rewrite.

This is more workflow than Coverify should copy directly. The interesting part
is not that there are many named stages. The interesting part is that each
stage is responding to a real observed failure mode.

### Verification / Trust Model

QED's internal verification has six phases:

1. Problem-statement integrity.
2. Completeness and originality.
3. Citation verification.
4. Subgoal-tree validation.
5. Human-specified rules, when supplied.
6. Detailed step-by-step mathematical verification.

Phases 1-5 are structural. Phase 6 is detailed local proof checking. The paper
emphasizes that structural failure should stop the expensive detailed review:
if the proof solves the wrong problem, cites nonexistent theorems, or leaves
the proof architecture incomplete, line-by-line checking is not useful.

QED also forces provers to identify the hardest original proof steps and write
those steps in maximal detail. This directly attacks the common pattern where
an LLM writes polished surrounding prose while hiding the central difficulty
behind words like "obvious" or "standard."

The final guarantee in the reported research-project evaluation is not formal
proof. It is QED's internal model verification followed by domain-expert
assessment.

### Reported Success

The authors report 18 research projects contributed by 7 domain-expert groups.
QED produced original, nontrivial, complete solutions to 5 projects across
probability, algebraic geometry, fluid PDE, and inverse problems. The authors
state that the successful runs received no expert guidance during generation,
and that the final proofs were independently checked by the relevant experts.

They also report an observed false-positive rate of 0 out of 17 for the QED
verifier with Codex GPT-5.5 in their experiment: across 214 proof candidates,
17 were accepted by the verifier, and each accepted candidate was later
accepted by the corresponding domain expert. This is promising, but it is not a
general calibration theorem. It is one reported configuration on one collection
of expert-proposed research projects.

The paper does not provide full details for every failed project, partly
because some remain active research problems.

### What Coverify Should Take

QED is useful as a review checklist and as evidence that separation of roles
matters.

For Coverify, the most reusable pieces are:

- problem-statement integrity before detailed proof checking
- exact citation/source verification
- explicit hard-step expansion
- structural review before detailed review
- separation between proposer context and verifier context
- summaries of failed attempts as durable artifacts

The least reusable part is the full fixed stage sequence. Coverify's current
direction is better: let agentic preparation inspect the source bundle and
choose relevant context, then validate paths, citations, ranges, hashes, and
review outputs mechanically. A QED-style decomposition can be something an
oracle does when useful; it does not need to become a Python workflow graph.

## AI Co-Mathematician

Source: [AI co-mathematician: Accelerating mathematicians with agentic
AI](https://arxiv.org/abs/2605.06651), Zheng et al., 2026.

### What It Is Trying To Do

The AI co-mathematician is not primarily presented as an autonomous proof
factory. It is a workbench for human mathematicians. The authors frame the
target activity as mathematical research: refining the problem, exploring
examples, searching literature, running computations, preserving failed
hypotheses, writing reports, and asking for human help when the system reaches
a roadblock.

This matters for Coverify because Cosheaf is also meant to be a durable
mathematical workspace, not merely a transcript store.

### Harness / Workflow Model

The system is organized around a project coordinator agent. The coordinator
interacts with the user, clarifies the project goal, delegates to parallel
workstreams, and reads the state of a shared filesystem.

Workstreams can branch into specialist agents: literature search,
computational exploration, proof attempts, code execution, and report writing.
The system keeps internal messages and persistent files, so the project state
survives beyond one chat response.

Failed explorations are first-class. If a workstream fails, that failure can be
recorded as durable negative knowledge instead of disappearing from context.
The coordinator can use those failures later to avoid repeating the same route.

There is also a review layer. Workstream outputs are submitted to reviewer
agents that can check references, code outputs, and logical correctness.
Reviewers persist across rounds, so the system can iterate on the same report
instead of starting over each time.

For benchmark evaluation, the authors used a special final-answer mode. That
mode bypasses the normal problem-definition conversation, sets the sole goal to
"solve the problem," and imposes a time limit: 24 hours internally and 48 hours
for FrontierMath.

### Verification / Trust Model

The normal research workbench is human-in-the-loop. AI reviewers are useful
filters, but the paper explicitly discusses risks in substituting AI review for
human mathematical judgment.

The limitations are important:

- reviewer-pleasing bias, where a flawed argument evolves until the reviewer no
  longer detects the flaw
- non-terminating disagreement loops, where revisions and rejections spiral
  instead of converging
- the mismatch between how fast an agent can generate a long proof attempt and
  how slowly a human expert can verify it

So the system demonstrates the value of agentic work organization, not that
model reviewers are a complete substitute for formal or expert verification.

### Reported Success

The paper reports three human-facing case studies:

- A group-theory problem from the Kourovka Notebook. The system produced a
  flawed proof route that a reviewer caught; the human mathematician recognized
  a useful strategy in the failed route and filled the gap, leading to a
  resolution.
- Stirling-coefficient conjectures in representation theory. With a user
  primer and suggested directions, the system produced proofs for two
  conjectures that the paper says were under detailed human review.
- A Hamiltonian-systems lemma. With user-supplied papers and context, the
  system produced a key lemma whose proof withstood checking and essentially
  resolved the user's question.

For static benchmarks, the authors report an internal benchmark of 100
unleaked research-level mathematics problems with code-checkable answers. They
state that the AI co-mathematician significantly outperformed single-call
Gemini 3.1 Pro and Gemini Deep Think baselines.

For FrontierMath Tier 4, Epoch AI tested the system blind in final-answer
mode. Excluding two public sample problems, it solved 23 of 48, or 48%. The
paper notes that this is higher than the Gemini 3.1 Pro base model at 19%.
It also notes a major caveat: the co-mathematician used its own tool
implementations and had no limit on model calls or tokens, so its inference
cost is likely higher than systems run in Epoch's standard harness.

### What Coverify Should Take

This is the strongest paper here for the idea that the workspace matters.

For Coverify:

- Cosheaf should be the durable workspace. Do not build a second hidden memory
  system if the information belongs in pages, issues, PRs, comments, or source
  links.
- Failed routes should be preserved when they prevent repeated work.
- Agentic preparation should select context from the visible source bundle and
  workspace state, not from a hidden planner's private assumptions.
- Review should make room for obstruction reports and "needs human" outcomes.
- Human-facing reports should distinguish solved, promising, failed, and
  unverified work.

What not to copy yet: a scheduler, a learned prioritizer, or a large parallel
agent hierarchy. The paper shows that those can help, but it does not show that
Coverify needs them before the simpler issue/PR/review loop is evaluated.

## AlphaProof Nexus

Source: [Advancing Mathematics Research with AI-Driven Formal Proof
Search](https://arxiv.org/pdf/2605.22763), Tsoukalas et al., 2026. Results:
[google-deepmind/alphaproof-nexus-results](https://github.com/google-deepmind/alphaproof-nexus-results).

### What It Is Trying To Do

AlphaProof Nexus is a formal proof-search system. Its input is not a raw
natural-language problem. The input is a Lean file containing a target theorem,
definitions, imports, and a proof body with `sorry` placeholders. The output is
a `sorry`-free Lean proof.

This means the system starts much closer to a machine-checkable artifact than
QED or the AI co-mathematician. It also means that human or agentic
autoformalization work has already happened upstream.

### Harness / Workflow Model

The basic agent is a set of independent prover subagents. Each subagent runs a
multi-turn LLM loop, edits the Lean sketch using search-and-replace, and checks
the result with Lean after each turn. If Lean reports errors or open goals,
those diagnostics feed the next turn. If an episode ends with remaining
`sorry`, the subagent leaves a summary for future episodes.

The paper studies several extensions:

- Agent A: basic independent LLM prover subagents with Lean feedback.
- Agent B: the basic agent plus calls to AlphaProof on selected subgoals.
- Agent C: an evolutionary population of proof sketches rated by LLM critics.
- Agent D: the full system combining AlphaProof calls and evolutionary sketch
  population.

The evolutionary mechanism is interesting but subtle. It keeps a database of
incomplete proof sketches. Rater agents compare sketches for plausibility,
clarity, and novelty, and those comparisons are aggregated into Elo-like
scores. Future proof attempts can sample from this population.

### Verification / Trust Model

Lean is the central verifier. A final candidate must compile and contain no
`sorry`. The system also uses a validator to ensure the problem statement was
not changed unsafely.

The paper is careful about statement fidelity. For the Erdos-problem results,
experts validated that the Lean statement faithfully captured the original
informal conjecture. This is an important point: Lean can verify that a formal
statement follows from its formal assumptions, but it does not by itself
guarantee that the formal statement is the intended informal theorem.

The paper's failure analysis also matters. High-scoring sketches sometimes
hid the core difficulty in helper lemmas with `sorry`, or cited hallucinated
literature lemmas. End-to-end formal verification is what prevented those
sketches from being accepted.

### Reported Success

The full-featured agent solved 9 of 353 formalized Erdos problems within the
reported budget. The paper says two had been open for 56 years. The system also
proved 44 of 492 autoformalized OEIS conjectures.

The architecture comparison is especially relevant for us. A basic independent
subagent system replicated the nine Erdos successes in post-hoc comparison,
although at higher cost on the hardest problems. AlphaProof calls sometimes
gave 2x to 5x savings, but were less cost-efficient on other problems.
Evolutionary variants were not uniformly superior at comparable cost.

The authors report per-problem inference costs of a few hundred dollars, with
high variance. They also note that reported costs do not capture the full cost
of discovering which problems are tractable.

### What Coverify Should Take

The acceptance contract is the main lesson: candidate search can be messy, but
accepted claims need a hard gate.

For Coverify, analogous gates could be:

- a Lean or other formal proof
- an exact certificate checker
- a finite exhaustive computation with reproducible artifacts
- a source-grounded theorem/citation checker plus trusted natural verifier

Without such a gate, the status should remain "proposed" or "needs human,"
even if the proof looks convincing.

What not to copy yet:

- population databases
- Elo-style sketch scoring
- evolutionary sampling
- expensive parallel search across many variants

Those ideas may become useful if evals show that simple independent attempts
are losing on Coverify tasks. The AlphaProof Nexus paper itself is evidence
that the simple agent can be surprisingly strong.

## Rethlas / Archon

Source: [Automated Conjecture Resolution with Formal
Verification](https://arxiv.org/abs/2604.03789), Ju et al., 2026. Code:
[Rethlas](https://github.com/frenzymath/Rethlas) and
[Archon](https://github.com/frenzymath/Archon).

### What It Is Trying To Do

This paper combines two systems:

- Rethlas, an informal mathematical discovery agent.
- Archon, a Lean 4 formalization agent.

The paper's goal is end-to-end research-level theorem solving with formal
verification. Rethlas finds a candidate natural-language proof. Archon turns
that proof into a Lean 4 project and fills missing details until the result is
machine-checkable.

### Harness / Workflow Model

Rethlas has a generation agent and a verification agent. The generator proposes
candidate informal proofs. The verifier checks them. If verification fails,
feedback goes back to the generator.

The generation agent is prompted with a tactic inventory:

- construct toy examples
- construct counterexamples
- search relevant mathematical results
- propose subgoal decomposition plans
- prove directly
- recursively prove with parallel subagents
- identify key failures

The paper emphasizes that these skills are not a fixed order. The agent is
supposed to choose tactics based on the current mathematical state.

Retrieval is central. Rethlas uses Matlas, a mathematical theorem-search
engine. The paper reports that the Rethlas experiments used a preliminary
arXiv statement corpus of about 13.6 million statements. It also describes a
newer Matlas system with 8.51 million curated statements from papers and
textbooks.

Rethlas keeps working memory: examples, counterexamples, decomposition plans,
and intermediate results. In Coverify terms, those artifacts should be pages,
issues, PR comments, reviews, and source links, not a private state database.

Archon is the stronger correctness layer. It initializes a Lean project,
collects references, creates topic-specific files, formalizes definitions and
statements, fills proof gaps, and iterates with Lean diagnostics.

Archon uses a Plan Agent plus Lean Agents. The Plan Agent works in fresh
context to decompose and redirect. Lean Agents execute scoped formalization
tasks. When formalization stalls, Archon can ask an informal agent for a more
detailed subproof or an alternative route.

### Verification / Trust Model

Rethlas's verifier is still a model-based natural-language reviewer. It checks
skipped steps, hidden gaps, unused assumptions, citation existence, source
applicability, and terminology shifts. That is useful, but it is not the final
guarantee in the paper.

The durable guarantee comes from Archon:

- `lake build` succeeds
- no `sorry`
- no added axioms or escape hatches
- Comparator checks that top-level formal theorem statements match a
  human-reviewed simplified specification

This split is crucial. If we cite Rethlas/Archon as evidence, the evidence is
not "a big prompt taxonomy is enough." It is "informal search plus retrieval
can find routes, and a formal gate can turn some of them into trusted results."

### Reported Success

The main result is Anderson's 2014 weak quasi-completeness question in
commutative algebra. Rethlas found a route using a Jensen result retrieved
through Matlas. Archon then formalized the proof in Lean 4.

The formalization is large: the paper reports about 19,448 lines of Lean 4
across 42 files, completed in about 80 hours of agent runtime. The paper says
the process was autonomous except for human help downloading paywalled PDFs and
placing them into the reference directory; no mathematical judgment was
provided during that intervention. The final formalization passed `lake build`
and Comparator checks.

The paper also reports two FirstProof formalizations. Problem 6 was completed
fully autonomously in about 30 hours. Problem 4 required one one-sentence
natural-language hint and took about 50 hours. The reported API costs were
approximately $750 and $1,200 respectively, using Claude Opus 4.6 calls.

For informal reasoning, the paper reports an algebraic-group problem where
Rethlas produced a correct solution while GPT-5.5 Pro through the webpage
produced an incorrect proof. It also reports a p-adic Hodge exploration where
Rethlas helped sharpen conjectures and construct a counterexample when an
assumption was removed.

### What Coverify Should Take

Rethlas is useful as a tactic library. It is not a reason to create a large
deterministic scheduler in Coverify.

Reusable ideas:

- theorem/source retrieval before proof invention
- examples and counterexamples as first-class tactics
- explicit failure synthesis
- separate proposer and verifier contexts
- hard acceptance gate when a claim is promoted
- fresh-context planning when a long attempt has accumulated too much local
  failure context

The warning is equally important: if Coverify replaces Lean with a natural
verifier, that verifier needs a clear contract and evals. The Rethlas verifier
is an internal reviewer, not the final source of truth.

## Gilbert-Pollak Verification-Function System

Source: [Towards Solving the Gilbert-Pollak Conjecture via Large Language
Models](https://arxiv.org/abs/2601.22365), Ke et al., 2026. Code and proof:
[keyisi2006/Steiner-Ratio](https://github.com/keyisi2006/Steiner-Ratio).

### What It Is Trying To Do

This paper attacks the Gilbert-Pollak / Steiner Ratio conjecture. The
conjectured Steiner ratio is `sqrt(3)/2`, about 0.866. The previous best lower
bound reported in the paper was 0.824. The authors improve the certified lower
bound to 0.8559.

This is not a generic theorem-proving system. It is a domain-specific
mathematical reduction plus an LLM-assisted search for certificate components.

### Harness / Workflow Model

The authors do not ask an LLM to write a proof of the conjecture. They first
reformulate lower-bound proving into a minimax-style feasibility problem over
splitting functions from an inductive pruning argument.

They introduce verification functions. These functions upper-bound splitting
functions and have structural properties that reduce continuous checking over
axis-aligned hyperrectangles to finite vertex checks, with monotonicity used in
unbounded regions.

The LLM's role is narrowed to proposing constrained geometric lemmas as code or
symbolic snippets. The useful lemma families are:

- trapped regular point lemmas
- valid 4-point Steiner tree lemmas

Local symbolic tools, especially Mathematica `Reduce`, derive, simplify, and
validate the candidate constraints. Accepted lemmas become new verification
functions.

A reward/verifier loop then runs:

1. Given a set of verification functions, binary-search a candidate lower
   bound.
2. Use a branch-and-bound feasibility oracle over parameter space.
3. When verification fails, identify a bottleneck region.
4. Convert that bottleneck region into a structured prompt.
5. Ask the LLM for lemmas that cover the bottleneck.
6. Validate candidate lemmas symbolically and add them if they pass.

This is a strong example of the right LLM shape: the model proposes artifacts
in a constrained language, and local verifiers decide whether those artifacts
matter.

### Verification / Trust Model

The trust model is much harder than natural-language review. Candidate lemmas
are checked by symbolic computation and then assembled into verification
functions. The final lower bound is supported by a certificate-style
verification process and a human-readable proof appendix.

The paper still leaves room for audit. Symbolic and computational verification
must be inspected carefully before being treated like a proof assistant. The
authors also discuss human verification and future formalization.

### Reported Success

The system improves the certified lower bound from 0.824 to 0.8559. The paper
reports about ten refinement iterations and thousands of LLM calls, with LLM
cost on the order of a few hundred dollars. It also reports that the reward
model computation required about 11.7 hours.

The authors include an ablation: removing bottleneck-region reflection failed
to improve the lower bound across the tested rounds. That is useful evidence
that failure localization was not just cosmetic.

The result is an advance toward the Gilbert-Pollak conjecture, not a proof of
the full conjecture.

### What Coverify Should Take

This is the best paper here for certificate-driven design.

For Coverify, the analogous move is to ask: what artifact can a model propose
that a local checker can judge?

Possible examples:

- finite obstruction manifests
- exact enumerations
- branch-and-bound certificates
- LP or SDP dual certificates
- machine-checkable reductions
- source-backed theorem-use manifests
- small counterexample objects

The verifier should expose the smallest failing cases or uncovered regions to
the next oracle call. That is a better reflection signal than asking an LLM to
"think harder."

Do not build a generic reflection loop first. Build a certificate language and
let verifier failures drive the next prompt.

## Cross-Paper Lessons For Coverify

### 1. "Agentic" Does Not Mean "Unstructured"

The papers that work do not replace structure with vibes. They structure the
artifact, not necessarily the control flow.

For Coverify, that means:

- `prepare_context` can be one agentic step over the allowed source bundle.
- The output of `prepare_context` should be validated mechanically: paths
  exist, ranges resolve, cited hashes match, links are valid, and the answerer
  only cites allowed material.
- The runner should avoid building a deterministic planner for judgments the
  agent can make by reading the workspace.

This matches the current design direction: small harness, agentic preparation,
mechanical validation.

### 2. Verification Is The Design Center

Every paper's success story depends on its verifier:

- QED: structured model review plus domain experts.
- AI co-mathematician: reviewer agents plus human mathematicians, with known
  reviewer failure modes.
- AlphaProof Nexus: Lean.
- Rethlas / Archon: natural-language verifier for candidates, Lean/Comparator
  for final acceptance.
- Gilbert-Pollak: symbolic and computational certificate checks.

So Coverify should not start by copying a multi-agent scheduler. It should
start by defining what can be accepted, what remains proposed, and what needs
human review.

If we assume a natural verifier that is never wrong, then the workflow becomes
very simple:

```text
agentic context preparation
  -> candidate proof/answer
  -> trusted verifier
  -> accepted artifact if verifier passes, otherwise retry or record failure
```

But the papers do not prove that current natural verifiers are never wrong.
They either use formal/computational gates, expert review, or explicitly report
model-reviewer failure modes. A natural verifier can be used, but its contract
and calibration evals have to be explicit.

### 3. Source Links Are Not Decoration

Citation and source grounding are repeated failure points. For a public
knowledge base, source links are part of the mathematical artifact.

Coverify outputs should prefer source-backed statements:

- claim
- exact source link or local page reference
- applicable assumptions
- line/range or theorem identifier when available
- note on whether the source was verified mechanically, by model review, or by
  human review

Hardcoded filename links are a weak substitute. If Cosheaf has an `@`-style
resolver for theorem identifiers, the harness should use the resolver and let
Cosheaf enforce uniqueness or report ambiguity.

### 4. Durable Negative Knowledge Is Valuable

The AI co-mathematician and Rethlas both emphasize failed routes. QED records
proof effort summaries. Gilbert-Pollak uses failed verifier regions as the
next prompt.

Coverify should preserve:

- failed proof routes
- counterexamples
- citation failures
- verifier bottlenecks
- statement-restatement mismatches
- reasons a PR was rejected

This should live in Cosheaf artifacts, not hidden local memory.

### 5. Complexity Needs An Eval Before It Enters The Harness

These systems contain many tempting components: decomposition graphs,
regulators, tactic taxonomies, recursive subagents, workstream schedulers,
Elo-rated sketch populations, and reflection loops.

The right Coverify bar is:

```text
Only add a harness component when it beats the simpler agentic loop on a real
evaluation set and its output can be validated mechanically.
```

Until then, keep the behavior in prompts, skills, and oracle calls.

## Suggested Coverify Design Experiments

These experiments are the practical bridge from the papers to our harness.

1. Baseline agentic context prep.
   Give the agent the question, thread, and source-bundle root. Let it read
   files and produce a cited context packet. Mechanically validate paths,
   ranges, and source identifiers.

2. QED-style review checklist.
   On the same attempts, compare a simple reviewer against a reviewer that
   explicitly checks problem integrity, citation grounding, hard-step detail,
   and local correctness.

3. Rethlas tactic prompt only.
   Add examples, counterexamples, theorem search, subgoal decomposition, and
   key-failure synthesis as optional tactics inside the attempt prompt. Do not
   add a deterministic tactic scheduler. Measure whether outputs improve.

4. Trusted-verifier simulation.
   Treat an independent strong model as the verifier, but log all pass/fail
   reports and run human spot checks. This tests whether "natural verifier as
   gate" is plausible before making it authoritative.

5. Certificate-language search.
   Pick one problem class where the output can be locally checked. Use the
   Gilbert-Pollak pattern: candidate artifact, verifier failure localization,
   next prompt from the smallest failure.

6. Source-link resolver test.
   Replace filename-only citations with resolver-backed theorem references
   where possible. If a reference is ambiguous, the output should fail
   validation or request disambiguation.

Metrics should include false-positive rate, citation failure rate, source-link
quality, accepted PR rate, durable failed-route quality, cost, latency, and how
often a run produces reusable knowledge even when it does not prove the target
claim.

## Bottom Line

The design space is not "simple single prompt" versus "huge multi-agent
machine." The promising middle is:

```text
small harness
+ agentic context preparation over visible files
+ source/citation mechanics
+ one strong attempt or oracle call
+ independent verifier
+ durable Cosheaf artifacts
+ evals before adding workflow machinery
```

That is the path most consistent with the papers and with Coverify's current
philosophy.
