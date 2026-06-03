# LLM Math Failure Modes

This is a consolidated list of problems seen in LLM-assisted mathematics. It
combines:

- QED's explicitly documented failure modes.
- Related warnings and mechanisms from AI co-mathematician, AlphaProof Nexus,
  Rethlas / Archon, and the Gilbert-Pollak LLM system.
- Coverify/Cosheaf issues we have already run into while building
  repo-grounded chat and source-linked answers.

Use this as a design checklist. It should not become a giant deterministic
workflow. Most responses belong in prompts, skills, source-bundle preparation,
review policy, and mechanical validation.

For a shareable note focused only on prover-side failures and prompt or
protocol mitigations, see
[Prover-Side Failure Modes And Mitigations](prover-failure-summary.md).

## Top-Level Taxonomy

The clean classification is three buckets:

| Bucket | Meaning | Typical examples |
| --- | --- | --- |
| Prover failures | The candidate mathematical output is bad before verification. | Wrong proof, skipped hard step, hallucinated theorem, unstable plan, proving a nearby statement, missing counterexample. |
| Verifier failures | The gate that should judge the candidate is biased, incomplete, non-terminating, or unhelpful. | Self-verification bias, reviewer-pleasing false consensus, unfocused verification, failure report without localization. |
| Harness failures | The system around the model gives the wrong context, loses trust metadata, publishes unusable output, or fails to preserve durable state. | Stale source bundle, ambiguous `@id`, bad source-link rendering, raw output treated as knowledge, no audit bundle, premature workflow machinery. |

Context/specification and publication/persistence failures are harness
failures. They can cause prover or verifier failures, but the fix belongs in
the source-bundle contract, output contract, audit trail, Cosheaf artifact
model, or eval harness.

## Source Legend

- **QED**: [QED: An Open-Source Multi-Agent System for Generating Mathematical
  Proofs on Open Problems](https://arxiv.org/pdf/2604.24021).
- **AICM**: [AI co-mathematician: Accelerating mathematicians with agentic
  AI](https://arxiv.org/abs/2605.06651).
- **APN**: [AlphaProof Nexus](https://arxiv.org/pdf/2605.22763).
- **R/A**: [Rethlas / Archon](https://arxiv.org/abs/2604.03789).
- **G-P**: [Gilbert-Pollak LLM system](https://arxiv.org/abs/2601.22365).
- **Coverify**: failures or design pressure observed in the current
  Cosheaf/Coverify repo-chat work.

## Failure Inventory

| Bucket | Failure mode | Where it appears | What goes wrong | Coverify response |
| --- | --- | --- | --- | --- |
| Verifier | Context contamination | QED; related to AICM reviewer loops and R/A proposer/verifier split | The same model/session that generated a proof becomes predisposed to accept it. Private attempt history can make a reviewer inherit the prover's assumptions. | Use an independent verifier context. The verifier sees the original task, allowed sources, and candidate answer, not the prover's private scratch. |
| Verifier | Same-model blind spots | QED; AICM benchmark gap between base model and workbench; R/A compares Rethlas against standalone GPT-5.5 Pro | One model family repeats the same style of mistake across generation and review. | Prefer a distinct verifier backend or at least a fresh role/context. Record verifier identity and model in audit metadata. |
| Prover | Citation hallucination | QED; AICM; R/A | The model invents papers, theorem numbers, URLs, theorem statements, or source locations. | Source claims need exact source refs. Validate paths, line ranges, links, and quoted theorem identifiers mechanically when possible. |
| Prover | Citation-substitution or source-scope error | R/A; QED; AICM | A real source is cited, but it proves a nearby statement, uses different hypotheses, or has terminology that does not match the current problem. | Review source applicability, not just source existence. Context prep should include hypotheses and local definitions around cited theorems. |
| Prover | Problem modification / specification drift | QED; APN; R/A Comparator checks; AICM problem-definition phase | The proof solves a weakened, strengthened, or nearby problem while looking plausible. Formal systems can prove the wrong formalization if statement fidelity is not checked. | Preserve the original issue/question separately from restatements. Verification starts with problem-statement integrity. |
| Prover | Hard step skipped | QED; APN bad `sorry`; R/A skipped-step checks | The proof spends detail on easy surrounding material and hides the core difficulty behind "standard," "obvious," or a helper lemma. | Review must identify the key original step and demand detail there. In formal/certificate work, central obligations cannot be hidden behind placeholders. |
| Prover | Hidden gap behind helper lemma | APN; QED; R/A | A candidate sketch moves the hard part into a lemma that restates the problem or cites a nonexistent literature result. | Treat helper lemmas as claims requiring the same source/proof status as the main theorem. No promotion if a critical lemma is only asserted. |
| Prover | Unstable proof plan | QED; R/A failure synthesis; AICM workstreams | The model changes strategy mid-proof, abandons dependencies, or mixes incompatible plans. | If a plan matters, make it a visible artifact: issue decomposition, PR body, page section, or review comment. Do not keep it as hidden runner state. |
| Verifier | Unfocused verification | QED | A verifier tries to check problem integrity, citations, local logic, completeness, and significance all at once, and misses fatal issues. | Stage review conceptually: problem match, source/citation match, proof structure, then local correctness. This can be one prompt, but the checklist must be ordered. |
| Verifier | Reviewer-pleasing false consensus | AICM; related to QED self-verification | A flawed proof evolves until reviewer agents stop noticing the flaw, even though the argument remains wrong. | Do not promote because "review loop converged." Promotion needs a hard gate, source-backed proof, certificate, formal check, or human review. |
| Verifier | Non-terminating review disagreement | AICM | Prover and reviewer keep revising and rejecting without progress, sometimes producing increasingly hallucinated reasoning. | Budget retries. If review does not converge, record a precise obstruction or `needs-human` result rather than continuing indefinitely. |
| Harness | Repeated failed route | AICM; R/A; QED effort summaries; Coverify philosophy | The system retries the same false invariant or proof route with different prose. | Negative knowledge is durable only when it says what failed, why, and what would make a retry materially different. |
| Prover | Missing counterexample discipline | R/A; Coverify eval candidates | The model keeps trying to prove a false or fragile claim instead of searching for a small obstruction. | Attempt prompts and reviewers should explicitly consider counterexamples when assumptions look weak or a proof route stalls. |
| Prover | Retrieval treated as reasoning | R/A warning through Matlas usage; QED citation checks; AICM literature examples | The model finds relevant-looking text and treats it as proof without checking definitions, hypotheses, or applicability. | Retrieval output is evidence to inspect, not accepted knowledge. Source context should include enough surrounding material to check use. |
| Harness | Raw output mistaken for knowledge | AICM working reports; Coverify philosophy | Long transcripts, generated Markdown, and oracle answers are treated as durable knowledge without distillation or review. | Useful raw output becomes a compact page, PR, review, obstruction, source note, or audit link. Raw output alone is not accepted knowledge. |
| Harness | Hidden private memory | AICM shared filesystem; R/A working memory; Coverify design pressure | Useful state lives in a private workspace or local log, so future humans and agents cannot inspect or review it. | Cosheaf is the durable memory. If it matters tomorrow, it becomes a page, issue, PR, review, comment, or linked audit. |
| Harness | Stale source bundle or uploaded cache | Coverify; related to AICM/strong-oracle uploaded-file mode | The answer is based on old branch files, mixed snapshots, or a stale uploaded project. | Key all source bundles/uploads by source id or tree hash. Include hashes in audit metadata. Do not silently mix snapshots. |
| Harness | Bad citation rendering / unusable links | Coverify | The answer may cite a source, but the UI cannot make it useful because refs are backticked, hardcoded as filenames, or line anchors do not resolve as intended. | Treat rendering as part of the citation contract. Validate output shape and prefer resolver-backed references for mathematical objects. |
| Harness | Ambiguous theorem identifiers | Coverify/Cosheaf design pressure; related to QED exact-statement matching and R/A source applicability | A reference like `@foo` can name more than one theorem, or a filename link identifies a document but not the mathematical object. | Cosheaf should enforce unique block ids or return ambiguity. Coverify should fail validation or request disambiguation rather than guessing. |
| Harness | Poor mathematical presentation | Coverify; AICM native mathematical artifacts | An answer is technically text, but it does not use math notation, theorem/proof structure, or source links, so it is not credible as mathematical knowledge. | Coflat output rules: use TeX math, theorem-like blocks for durable claims, and source-backed references. |
| Harness | Over-broad context / context pollution | QED; R/A fresh Plan Agent; Coverify gather design | Too much irrelevant history or failed scratch causes the agent to reason from stale assumptions or avoid hard tasks. | Let `prepare_context` be agentic but bounded to the source bundle. Validate selected excerpts and keep failed routes as concise durable notes, not giant dumps. |
| Harness | Free-form artifact with no verifier | G-P; APN; R/A; QED | A model produces a plausible proof, lemma set, or computation, but no local mechanism can decide whether it certifies anything. | Prefer constrained artifact languages when possible: formal proof, finite certificate, exact computation, source-use manifest, or obstruction witness. |
| Harness | Computation without audit | G-P; AICM code-output review; Coverify audit bundles | The model cites a computation, but the code, inputs, parameters, or exact outputs are missing or unreplayable. | Preserve audit bundles for backend calls and computational claims. Promote only distilled, reviewable results with enough reproducibility metadata. |
| Verifier | Failure localization missing | G-P; R/A identify-key-failures; QED regulator | A verifier says "wrong" but not where the next attempt should focus. | Verifiers should return the smallest failing step, missing source condition, uncovered case, or bottleneck region when possible. |
| Harness | Human verification bottleneck | AICM; QED; R/A | Agents can generate long proof attempts faster than experts can check them. | Internal review filters should protect human attention. Human review should see concise claims, source links, verifier reports, and exact open questions. |
| Harness | Inference-cost opacity | AICM; APN; QED; G-P | Reported success can depend on much higher compute, multiple calls, or hidden discovery cost. | Log backend/model/cost/time when available. Evals should compare strategies under explicit budgets. |
| Harness | Premature workflow machinery | Coverify; lessons from QED/R/A/APN | We copy named stages, tactic taxonomies, or evolutionary machinery before proving they improve our tasks. | Keep complex behavior in prompts/skills first. Add Python orchestration only when the behavior is stable, mechanical, and eval-backed. |

## QED's Seven Explicit Failure Modes

QED names seven LLM failure modes. In Coverify terms, they map as follows:

| QED failure | Coverify interpretation | Related papers |
| --- | --- | --- |
| Context contamination | Verifier must not inherit prover scratch or private attempt state. | AICM reviewer-loop risks; R/A proposer/verifier split. |
| Citation hallucination | Source links and theorem uses need exact validation, not just plausible prose. | AICM citation checking; R/A Matlas/source applicability. |
| Misallocation of proof effort | The proof must expose and solve the hard original step. | APN bad `sorry`; R/A skipped-step verification. |
| Unstable proof plans | If a plan matters, make it visible and check consistency across subclaims. | R/A decomposition/failure synthesis; AICM workstreams. |
| Unfocused verification | Order review checks so fatal structural errors stop detailed checking. | AICM reviewer limitations; R/A formal final checks. |
| Problem modification | Preserve original statement and reject nearby-problem proofs. | APN statement-fidelity validation; R/A Comparator; AICM problem-definition phase. |
| Single-model bottleneck | Avoid relying on one model's blind spots for both proof and review. | AICM workbench beats base model; R/A compares system against standalone GPT-5.5 Pro. |

## Coverify-Specific Problems Already Seen

These are not all mathematical reasoning failures, but they directly affect
whether an LLM answer is useful in Cosheaf:

- Answers without mathematical notation or source-backed claims look weak even
  if the prose is fluent.
- Filename-only citations are not enough. A user needs to know which theorem,
  definition, line range, or block id supports the claim.
- `path.md#Lx-y` is only useful if Cosheaf renders it as a usable file/line
  reference. Backticks can break that rendering.
- Line anchors can identify a document span but not the mathematical object.
  Coflat block ids and `@id` references are better for theorem dependencies.
- `@id` only works if Cosheaf enforces uniqueness or returns ambiguity.
- A fast answer can be suspicious if it does not show evidence that it read the
  needed source material.
- A gatherer that chooses context heuristically can miss far-apart but jointly
  necessary passages. The agentic preparer should inspect files directly, while
  the harness validates the returned paths/ranges.
- Chat answers must not silently use old branch snapshots or stale uploaded
  files.

## Design Checklist

Before publishing a substantive answer, proof attempt, review, or knowledge
page, check:

1. Did it answer the original problem, not a nearby restatement?
2. Are repo-specific claims supported by current allowed sources?
3. Are citations exact enough to be inspected in Cosheaf?
4. Are source theorem hypotheses and terminology matched?
5. Is the hard step actually proved or marked as open?
6. Are any helper lemmas accepted, proved, cited, or explicitly conjectural?
7. Is the verifier independent enough from the proposer?
8. If the verifier rejects, does it say what failed and what would make a
   retry different?
9. If the result matters tomorrow, did it leave a Cosheaf artifact?
10. Is the acceptance status honest: accepted, proposed, needs-human, rejected,
    or failed route? If it claims a resolution artifact, is that type from
    `src/coverify/math_contract.py`?

The short version:

```text
Do not trust fluent proof-shaped text.
Trust current sources, explicit statements, hard-step detail, independent
verification, and durable reviewed artifacts.
```
