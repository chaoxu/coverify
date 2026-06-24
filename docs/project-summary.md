# Coverify Project Summary

This is the short current-state description of Coverify: what the project is, what it is deliberately not, and which design decisions should guide future changes.

## What Coverify Is

Coverify is a small mathematical harness around [Cosheaf](https://github.com/chaoxu/cosheaf). It lets an agent or operator work over a bounded mathematical knowledge base, prepare prompts from that source state, call LLMs or other mathematical tools, verify the result, and write durable progress back to Cosheaf.

Coverify is meant for hard mathematical work where one answer is often not enough. A run may answer a source-grounded question, explore routes, package a precise theorem or construction target, call a strong resolver, record a failed route, open a PR, request review, or merge accepted knowledge. The point is not that every run proves something. The point is that useful mathematical work should compound instead of disappearing into chat history.

## What Coverify Is Not

Coverify is not a theorem prover, a formal verifier, or a replacement for human mathematical review. It is not the Cosheaf UI, issue tracker, wiki, or PR system. It should not keep hidden long-term memory outside Cosheaf. It should not browse the web or read unrelated local files by default. It should not grow one-off commands for every research project, benchmark, score, or certificate format.

Coverify also is not trying to become Codex for mathematics by adding a large deterministic planner. Codex works well as a coding harness partly because code has executable feedback everywhere: tests, types, linters, diffs, runtime errors, and real files. Mathematics usually lacks that dense feedback, so Coverify must be more explicit about source bounds, target fidelity, verification, review, negative knowledge, and evals.

## The Core Loop

The useful loop is:

```text
workspace + branch/source bundle + question
  -> prepare relevant context from allowed files
  -> produce an exploratory response or one exact mathematical resolution
  -> verify the candidate under the matching contract
  -> publish only checked, honestly labeled output
  -> leave durable state in Cosheaf when the result matters
```

Local audit bundles are provenance. Cosheaf is memory. If a fact, obstruction, issue state, review decision, or failed route needs to matter after the process exits, it should become a Cosheaf artifact or be summarized from an audit bundle into one.

## The Two Contracts

Coverify uses two output contracts.

**Exploratory response** is the default contract for chat, source-grounded answers, route exploration, issue triage, status summaries, conjecture shaping, and packaging resolution targets. It may answer directly, compare routes, call tools, identify gaps, or propose the next task. It must ground repo-specific claims in the source bundle and label speculation.

**Mathematical resolution** is the strict contract for one exact hard target. The prompt must specify the target, hypotheses, allowed context, relevant failed routes, required method or theorem if any, and the requested resolution artifact from `src/coverify/math_contract.py`. "Prover" is acceptable shorthand, but the artifact may be a proof, counterexample, construction, certificate, bound, obstruction, computation, or precise gap report.

Ordinary chat is not a third mode. It is an exploratory response with a direct-answer target. A broad "solve this issue" request starts as exploration unless the issue already contains a clean mathematical-resolution target.

## What We Decided

- **Cosheaf owns durable state.** Pages, issues, branches, PRs, reviews, comments, labels, and merges are the project memory.
- **Coflat is the mathematical document format.** Coverify should understand and preserve Coflat/Cosheaf source structure rather than inventing a separate knowledge format.
- **Keep Python mechanical.** Python should expose source bundles, Cosheaf operations, backend calls, audit trails, prompt previews, schema checks, path/range/citation validation, hashes, and verifier gates.
- **Keep judgment agentic.** Context selection, route choice, target framing, mathematical reasoning, and deciding what evidence matters should usually live in agents, skills, prompts, or oracle calls, then be mechanically validated.
- **Do not multiply modes.** Exploration and mathematical resolution are enough until evals show a real repeated failure that cannot fit either contract.
- **Use strong tools only when the target is sharp.** Exploration can shape the problem; mathematical resolution should spend strong-model budget on one exact target with strict acceptance rules.
- **Verification travels with the answer.** Anything sent to the user or written as durable mathematical state should be checked for source support, target fidelity, citation validity, honest uncertainty, and correct status labeling.
- **Negative knowledge counts.** A failed route, counterexample, invalid invariant, wrong theorem scope, or localized verifier objection is progress when it prevents repeated work.
- **Raw output is not knowledge.** Long transcripts and generated dumps should be distilled into compact claims, tables, examples, failed-route notes, PRs, or issue comments with status.
- **Project-specific tools live with the project.** A checker, score script, search tool, or domain-specific contract belongs in the golden project repo or companion repo, with Coverify only providing generic harness support.
- **Coverify should be a collection of generic tools.** External systems such as First Proof/ProofStack show the value of composing configurable agents and tools. Coverify should learn that lesson by exposing stable primitives, project-declared commands, audit trails, and verification gates rather than absorbing a large workflow runtime.
- **Prompt inspection is first-class.** `prepare-llm` commands should build the next LLM input and stop before backend calls or Cosheaf writes, so agents can inspect prompts without running the model.
- **Generated durable Markdown should not be hard-wrapped.** Ordinary prose paragraphs should stay on one logical source line, while headings, lists, tables, TeX blocks, and fenced code keep intentional structure.
- **GitHub publication is snapshot-only.** Lab history can remain on lab remotes; public GitHub releases should be intentional clean snapshots after privacy and project-specific checks.

## Project Runs

A mathematical project should be a Cosheaf workspace plus a local project workdir. The project workdir should contain `AGENTS.md` and usually `PROJECT.md`; concrete work belongs in issues or task pages. Day-to-day Codex sessions should start in the project workdir and call the scaffolded `bin/coverify` wrapper or Coverify skills.

If a run exposes missing mathematical knowledge, update the project. If it exposes a generic Coverify bug or missing generic capability, pause the project run, fix Coverify in this repo, run the Coverify checks, then resume. If it needs a domain-specific checker or script, put that in the project workspace or companion repo, not in the default Coverify CLI.

## Current Public Surface

The important current surfaces are source-bundle chat, repo oracle calls, gather evaluation, `chat prepare-llm`, `repo-oracle prepare-llm`, `verifying prepare-llm`, audited backend invocation, project-owned tool execution through `coverify-tools.json`, Cosheaf primitives, research eval seeding, and repo-owned Codex skills for context building, exploration planning, proof attempts, KB writing, PR review, cleanup, and run loops.

Real backend calls should keep writing the audit files: `prompt.md`, `answer.md`, `metadata.json`, `manifest.json`, and verifying journals where applicable. Preview paths should stop before backend invocation and before issue/comment/publication writes.

## Eval Direction

The next serious work is not more workflow machinery by default. It is eval discipline. Coverify needs frozen task sets that measure whether source-bounded preparation, visible state, verification, and Cosheaf-backed memory improve correctness and useful progress under a fixed budget.

The useful comparison set includes one-shot oracle calls, Codex-only operation, fixed QED-style pipelines, QED as a backend strategy, STAR-style visible state, natural-language blueprint spikes inspired by Lean systems, and the full Coverify loop. The metrics should include accepted progress per budget, false approvals, target drift, repeated dead ends, useful obstructions, accepted-node precision, and human review compression.

## Open Spikes

- Whether STAR-style visible attempt state and meta-strategy prompts improve outcomes enough to become skill guidance.
- Whether natural-language blueprint graphs can save human review time without pretending to be Lean.
- How to expose project-owned checkers and score loops cleanly without adding project-specific Coverify commands.
- Which harness framework ideas are worth adapting as backend or runner adapters, rather than replacing the simple Coverify/Cosheaf architecture.

The default answer to a new idea should be: first make it a project document, skill instruction, prompt pattern, or eval spike; add generic Coverify code only after the behavior is stable, mechanical, and repeatedly useful.
