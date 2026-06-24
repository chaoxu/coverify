# Atomic Attempts

This plan describes the Coverify attempt boundary we want around Cosheaf and Coflat. The goal is simple: an attempt is private work toward one candidate knowledge-base change, while Cosheaf remains the durable mathematical memory.

## Core Boundary

```text
Cosheaf stores knowledge.
Coverify stores work.
```

Cosheaf should contain problem statements, definitions, known results, useful failed-route notes, accepted computations, issues, PRs, reviews, and final status. It should not receive raw author drafts, raw critic reports, council brainstorms, model transcripts, scratch calculations, or large generated dumps.

An attempt begins from a Cosheaf snapshot and ends with zero or one promoted Cosheaf change. The intermediate work lives locally under `.coverify/attempts/<attempt-id>/` so it can be inspected and audited without polluting the knowledge base.

## Attempt Boundary

```text
Cosheaf issue/source snapshot
  -> local attempt bundle
  -> one candidate Coflat/Cosheaf change
  -> mechanical gates and fresh publication review
  -> accepted Cosheaf PR or no durable write
```

Coverify should not become the scheduler for a large Author/Critic workflow. It should record local attempt state, prepare prompts, run backend calls on request, validate outputs, and gate promotion. The agent remains the orchestrator: it may run an author call, critic call, council fanout, project tool, computation, or external workflow, but Coverify only records those calls and checks whether the final candidate is publishable.

## Local Attempt Bundle

A first implementation can use a small local bundle:

```text
.coverify/attempts/<attempt-id>/
  manifest.json
  goal.md
  source-snapshot.json
  candidate/
  calls/
  checks/
  promotion/
```

The bundle is audit and recovery state, not project memory. `calls/` may contain backend prompts, answers, tool runs, council replies, critic reports, verifier results, and external workflow outputs; call metadata identifies the role. If anything in the bundle should matter to future work, the attempt must promote a compact version into Cosheaf through a PR or accepted note.

The implemented promotion convention is `candidate/files/...`: paths under that directory mirror the Coflat/Cosheaf paths to write on the PR branch. Other files under `candidate/` are local draft or notes unless they are explicitly distilled into `candidate/files/...`.

`attempt start` exports a source bundle by default under `source-bundle/` and records its source id and snapshot hash in `manifest.json`. Use `--no-source-bundle` only when an attempt deliberately needs metadata but not rehydratable source files.

## Promotion Rule

Promote only compact durable knowledge:

- exact problem statements, theorem targets, construction goals, or optimization targets
- stable definitions, notation, hypotheses, and conventions
- proved lemmas, propositions, reductions, bounds, examples, counterexamples, constructions, certificates, and checked computations
- source-backed references and the exact imported fact being used
- concise status summaries for active problems
- useful failed routes that prevent repeated work
- clean open subproblems and packaged mathematical-resolution targets
- small human-reviewable computational certificates, small result tables, hashes, metadata, and reproducibility commands for larger artifacts
- final publication review verdicts when the verdict is useful future context

Do not promote raw transcripts, repeated summaries, scratch paths, huge logs, large datasets, binary blobs, or half-written proof fragments. For large computational artifacts, Cosheaf should store the claim, a small excerpt or certificate, the checker/verifier result, and a stable pointer/hash rather than the full dump.

Failed routes are promoted only when they prevent future wasted work. The promoted note should identify the route, why it looked plausible, the exact obstruction, the evidence for that obstruction, what would make a retry materially new, and what nearby variants remain possible. The raw failed attempt stays local; the cleaned mathematical lesson goes to Cosheaf.

## Publication Gate

The publication reviewer is mandatory for user-visible durable writes. It is the same critic role used inside attempts, but at a stricter scope: it reviews whether the proposed Cosheaf change is true, useful, concise, grounded, and worth adding to the shared knowledge base.

The reviewer should reject a change when it is false, unsupported, overstated, too vague, duplicated, too noisy, mostly transcript residue, too large for the repo, or not useful for future work. The gate asks:

```text
Can this safely improve the shared mathematical memory?
```

Correctness is necessary but not sufficient. Knowledge-base quality is part of the acceptance contract.

## Coflat And Cosheaf Gates

Coverify should replace First Proof's TeX-specific gates with Coflat/Cosheaf gates:

- changed Coflat parses
- rendered pages are inspectable
- internal links resolve
- `@` references resolve uniquely
- cited source paths, ranges, and hashes are valid
- proposed branches, PRs, reviews, and issue links exist
- project-declared checkers or verifiers pass when the issue requires them

These checks should be mechanical. Mathematical judgment stays in the reviewer/verifier prompt and, when available, project-specific tools.

Coverify should not implement Coflat parsing or `@` resolution itself when Cosheaf/Coflat exposes that surface. The current implementation has a generic validation hook: `attempt promote --validation-command '...'`. The command receives placeholders such as `{candidate_files_dir}` and `{source_bundle}`, and its audited result is stored under `checks/`.

## Prompt Contracts We Need

The hard part is prompt discipline. The first implementation should write strong prompts for these contracts before adding more workflow code:

- Contract selection: choose exactly one output contract, exploratory response or mathematical resolution. Ordinary chat and route exploration use exploratory response; one exact theorem, construction, counterexample, certificate, bound, obstruction, computation, or precise gap report uses mathematical resolution.
- Mathematical-resolution prompt: require exact statement, hypotheses, allowed context, relevant failed routes, required method if any, and one artifact type from `src/coverify/math_contract.py`. The verifier must reject nearby-target answers, ignored forced methods, hidden source use, and status claims stronger than the evidence.
- Author prompt: read the Cosheaf snapshot and current candidate, make one coherent candidate change, write uncertainty honestly, keep scratch out of the final artifact, identify the closest known failed route and why this attempt is materially different, and request council or tools only for specific subquestions.
- Private critic prompt: review the current candidate against the goal and sources, identify blocking issues, avoid rewriting the artifact, state whether the attempt repeats a known failed route, and produce feedback that can guide the next agent step.
- Publication reviewer prompt: decide whether the proposed Cosheaf change should enter the knowledge base, checking correctness, usefulness, concision, source grounding, status clarity, duplicate content, artifact size, failed-route quality, and retry novelty.
- KB writer prompt: distill only durable knowledge from an attempt bundle, especially failed-route lessons and verified computations, without adding stronger claims than the evidence supports.
- Tool request prompt: require exact input, expected output, verifier/checker command when available, artifact size policy, and how the result should be cited if promoted.

Each prompt should require status labels such as proved, checked computation, conjectural, obstruction, precise gap, failed route, or speculative route. Source-grounded claims need exact path, range, and hash when applicable. Each prompt should also say what not to do: do not paste raw transcripts into Coflat, do not hard-wrap ordinary prose paragraphs, do not publish speculation as result, do not cite unavailable sources, do not dump large artifacts, and do not treat a model preference as mathematical verification.

## Minimal CLI Direction

Start small:

```bash
coverify attempt start --workspace OWNER/REPO --issue ID
coverify attempt status ATTEMPT_ID
coverify attempt prompt ATTEMPT_ID --kind author
coverify attempt call ATTEMPT_ID --kind author --backend codex
coverify attempt record ATTEMPT_ID --call-dir .coverify/runs/...
coverify attempt promote ATTEMPT_ID
```

`attempt start` records the Cosheaf input snapshot and source bundle. `attempt status` summarizes local state without touching Cosheaf. `attempt prompt` prepares an LLM/tool prompt and stops before the call. `attempt call` prepares a prompt, runs the selected backend, and records the audited call under `calls/`. `attempt record` imports an existing backend audit or tool result into `calls/`. `attempt promote` runs local checks, an optional external validation command, and a fresh publication review, then opens a Cosheaf PR only if accepted and explicitly requested.

## End-To-End Example

```bash
coverify attempt start \
  --workspace chao/my-project \
  --issue 23 \
  --attempt-id gp-route-1

coverify attempt prompt gp-route-1 \
  --kind author \
  --json \
  --output-dir .coverify/attempts/gp-route-1/prompt-preview

coverify attempt call gp-route-1 \
  --kind author \
  --backend codex \
  --allow-codex-backend \
  --json

mkdir -p .coverify/attempts/gp-route-1/candidate/files/notes
$EDITOR .coverify/attempts/gp-route-1/candidate/files/notes/failed-route.md

coverify attempt call gp-route-1 \
  --kind publication-review \
  --backend codex \
  --allow-codex-backend \
  --json

coverify attempt promote gp-route-1 \
  --review-call-dir .coverify/attempts/gp-route-1/calls/002-publication-review \
  --validation-command 'cosheaf validate-files --source {source_bundle} --candidate {candidate_files_dir}' \
  --open-pr \
  --workspace chao/my-project
```

The exact validation command is project- or Cosheaf-provided. If no such command exists yet, omit `--validation-command`; promotion still requires candidate checks and an accepted publication review before `--open-pr` writes anything.

## Build Order

1. Define the local attempt bundle schema and status command.
2. Add prompt-preview support for author, private critic, verifier, KB writer, and publication reviewer calls. Done.
3. Add call-record import for existing backend audits, project tools, and external workflows. Done.
4. Add an integrated `attempt call` command for oracle-backed calls. Done.
5. Add candidate and promotion directories with a local accepted/rejected promotion record. Done.
6. Add source-bundle export at attempt start. Done.
7. Add generic validation-command wiring before any non-draft PR creation. Done.
8. Add PR creation for accepted candidates or explicitly requested drafts. Done.
9. Add optional helpers for council fanout and project-owned tool requests only after the role-neutral call recording works.

Stop there unless evals show that a more general workflow graph is needed.
