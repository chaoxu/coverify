# Coverify Design

Coverify is a small exploration system around
[Cosheaf](https://github.com/chaoxu/cosheaf) for mathematical work. It connects
source bundles, model and computation tools, verification gates, and Cosheaf
publication targets. It does not own the durable knowledge base or the user
interface.

The invariant:

```text
If an agent action matters after the process exits, it must leave a Cosheaf
artifact.
```

## Why Mathematical Resolution Exists

Some LLMs, theorem tools, and other black-box reasoners can solve hard
mathematical targets when the prompt is precise enough. A good resolution prompt
contains the statement or target, accepted facts, allowed source context,
relevant failed routes, and any required method. If the target requires a proof
by a specific route, a construction with a specific property, or use of a
particular theorem, that requirement is part of the target. Verification should
fail outputs that solve a nearby problem, ignore the forced method, or claim a
stronger status than the evidence supports.

Most difficult projects are not a sequence of ready-made one-shot targets.
Exploration is the main work: read the knowledge base, decide what matters,
test ideas, record failed routes, and package exact targets for strong
mathematical-resolution tools. Coverify exists to make that loop durable and
verified.

## Boundaries

Cosheaf is the durable workspace:

- pages
- branches
- pull requests
- reviews
- issues
- labels
- comments
- notifications
- merge state

Coverify provides deterministic mechanisms and tools:

- Cosheaf API adapters
- source-bundle loading and export
- backend invocation
- audit bundles
- gatherer output validation
- verifier gates
- eval tools
- fixed-sequence CLI commands

Exploration provides judgment:

- decide which context matters
- choose routes and tool calls
- ask for proofs, refutations, constructions, counterexamples, certificates, or
  computations when useful
- produce or request mathematical arguments
- verify correctness and status labels
- decide whether a failed route is worth recording

Do not move judgment into Python by default. Python code should validate paths,
line ranges, schemas, citations, hashes, and verifier verdicts. It should not
grow into a second planner, scheduler, or issue graph.

## Output Contracts

Coverify uses two contracts. Do not add a third mode for ordinary answers.

| Contract | Use When | Allowed Behavior | Required Check |
| --- | --- | --- | --- |
| Exploratory response | Chat, source-grounded questions, route exploration, issue triage, status summaries, conjecture shaping, and packaging resolution targets. | Answer directly, explain current source support, compare routes, identify gaps, call tools, propose next tasks, or package exact mathematical targets. Mark speculation and unsupported ideas. | Verifier checks source support, honest uncertainty, citation/link validity, no hidden source use, and no factual claim beyond the evidence. |
| Mathematical resolution | One exact hard target is ready for a strong tool. This may be a theorem, conjecture, counterexample search, construction, witness, bound, certificate, reduction, obstruction, or key step. | Produce proof, disproof, counterexample, construction/witness, bound/certificate, reduction, obstruction, or precise gap for the stated target. Follow any forced theorem, construction, method, or route constraint. Do not brainstorm or silently change scope. | Verifier checks exact target fidelity, hypotheses, mathematical steps, source use, required-method compliance, failed-route avoidance, and whether the claimed resolution is complete. |

A broad "solve this issue" request starts as exploratory response unless it
already contains a clean mathematical target. Exploration may hand a packaged
target to the prover/resolver. Normal chat answers are exploratory responses
with a direct-answer target. "Prover" is acceptable shorthand for the
mathematical-resolution tool, but the output need not be a proof.

## Layers

| Layer | Location | Role |
| --- | --- | --- |
| Engine | `coverify.engine` | Backend contract, audit records, self-verifying oracle. Cosheaf-agnostic. |
| Tools | `coverify.cli`, `coverify.cosheaf`, `coverify.integration`, `coverify.apps` | Deterministic command surface and adapters. |
| Explorer | Codex skills or another caller | Adaptive work: context building, route choice, tool use, PR writing, review. |
| Workspace | Cosheaf | Durable state and presentation. |

The command line is the boundary between exploration and the tools. Skills
call commands; they should not import internal Python modules.

## State Model

Durable state maps to Cosheaf primitives:

| Need | Cosheaf primitive |
| --- | --- |
| Accepted knowledge | Markdown page merged to `main` |
| Active attempt | Branch |
| Proposed change | Pull request |
| Verification decision | PR review |
| Localized objection | PR line comment |
| Backlog item | Issue |
| Lightweight state flag | Label |
| Failed route memory | Closed PR, closed issue, request-changes review, or accepted obstruction note |
| Transient answer | Issue/chat comment with source metadata |

Local state is operational only. Backend calls write audit bundles so a runner
can show what prompt was sent, what answer came back, and which files or hashes
were involved. If an audit result matters later, summarize or link it from a
Cosheaf artifact.

Do not add durable stores for:

- hidden long-term agent memory
- a Coverify-owned issue graph
- a branch or PR mirror
- a learned prioritizer
- a scheduler or job table before detached jobs exist

## Source Bundles

Repo-grounded work starts from a source bundle:

```text
SourceBundle
  source_id: stable opaque id, usually including workspace/branch/tree
  root: restricted directory containing allowed files
  manifest: paths, sizes, hashes, optional headings
  description: human-readable scope
```

The source bundle is the allowed repo context. A run may also use the current
thread text and general mathematical knowledge. Repo-specific claims must be
supported by the source bundle.

Forbidden by default:

- sibling repos
- local scratch outside the bundle
- user home files
- secrets
- web search
- unrelated issues, PRs, timelines, or old branch snapshots

If a backend uses uploaded files or a cached project, the upload must be keyed
by the same source id or tree hash. Stale uploaded context must fail closed.

## Agentic Preparation

When a task needs context selection, use an agentic preparation step instead of
building another deterministic gather planner.

Preferred repo-chat shape:

```text
question + thread + allowed source-bundle root
  -> agentically prepare relevant context
  -> mechanically validate selected paths/ranges/citations
  -> exploratory response, or packaged mathematical resolution when requested
  -> independent verifier with the matching contract
  -> response or comment
```

The gatherer may inspect files inside the allowed root and return exact
passages, missing-context warnings, conflicts, and a framed question. Coverify
validates the returned schema and excerpts before passing them on.
It should not decide mathematical relevance by a growing list of hard-coded
heuristics when an agent can inspect the allowed files directly.

## Backend Contract

A backend is a script, CLI, API wrapper, remote job, or fixture with a simple
contract:

```text
prompt on stdin or request body -> response text plus metadata
```

Each backend call records:

- prompt
- answer
- provider/model or command
- timing
- exit status or timeout state
- logs when available
- prompt and answer hashes
- source bundle metadata when relevant

The `verifying` backend composes generator, verifier, and adjudicator calls. It
is useful for smoke tests and bounded self-checking, but it is not a substitute
for source-backed proof, formal verification, or human review on hard claims.

## Verification

Substantive outputs need an independent check before publication.

For exploratory responses, a verifier should reject when:

- forbidden sources are used
- repo-specific claims are unsupported by the source bundle
- citations, semantic ids, or source links do not resolve
- source uncertainty or conflicts are hidden
- a plausible route is presented as an established proof
- the response does not produce a useful next artifact for the request

For mathematical resolution, a verifier should reject when:

- the answer solves a nearby problem instead of the asked one
- cited source statements do not match local hypotheses
- a proof, construction, counterexample, bound, or certificate hides the hard
  step
- evidence is presented with a stronger status label than it deserves
- relevant failed routes are retried without a material difference
- uncertainty or conflicting sources are smoothed over as a complete resolution

Verification output should identify the smallest useful failure: missing source,
wrong hypothesis, uncovered case, invalid inference, or unsupported conclusion.

## Publication

A result can be published as:

- stdout JSON for another tool
- a Cosheaf issue/chat comment
- a PR body or review
- a merged knowledge page after review

Publication should expose:

- final answer
- verification status
- source id or snapshot
- visible source list when useful
- warnings or refusal reasons
- durable issue/PR/comment URL when one exists

Publication should hide:

- raw prompts
- full context dumps
- backend scratch
- retry internals
- Forgejo implementation details

## GitHub Release Policy

GitHub publication is snapshot-only. Do not push or mirror the lab Git history
to GitHub by default. The public repository should receive a fresh commit built
from the current clean tree after private-string, secret, and project-specific
history checks pass.

Lab remotes can keep operational continuity. GitHub is the public source
snapshot.

## Operational Flow

For longer mathematical work, use the skills in `skills/`:

1. Build task-specific context from Cosheaf.
2. Check prior failed routes.
3. Choose the output contract: exploratory response by default, mathematical
   resolution only for a packaged target.
4. Choose one action: explore/answer, resolve a mathematical target, write,
   clean, or review.
5. Call a suitable tool, backend, or oracle when mathematical judgment is
   needed.
6. Validate outputs mechanically and with the matching verifier contract.
7. Leave durable state in Cosheaf.
8. Record what changed, what passed, and what remains blocked.

The runner should not merge raw model output as accepted knowledge. Useful
model output becomes a proposed page, PR, review, comment, or issue with clear
status.

## Current Public Surface

The public package includes:

- Cosheaf primitives for workspaces, files, issues, PRs, reviews, and merge
- `ask-oracle`
- `repo-oracle ask`
- `repo-oracle gather`
- `repo-oracle eval-gather`
- `chat ask`
- `chat-reply`
- `run-eval`
- `seed-research-evals`
- `prove-infinite-primes` as a small deterministic workflow example

Project-specific research tools should not live in the default public CLI. If a
specialized app becomes useful again, move it behind a clearly named optional
package or separate repository.

## Acceptance Standard

The useful loop is:

```text
workspace + branch/source bundle + question
  -> verified exploratory response or mathematical resolution
  -> source metadata
  -> durable Cosheaf record when publication is requested
```

If this loop is not simpler for the user than manually collecting files and
pasting them into a chat, cut scope until it is.
