# Gap Against AI Co-Mathematician

Reference: "AI Co-Mathematician: Accelerating Mathematicians with Agentic AI"
(Google, arXiv:2605.06651, May 2026), 22pp.

The paper frames an agentic *workbench* for open-ended mathematical research
rather than a monolithic prover. Its motivating observations:

- mathematicians act as manual connective tissue between conversational
  brainstorming, formal provers, and computational scripts
- coding environments are optimized for code lifecycle, not for the
  abstractions, proofs, and artifacts of mathematics
- agents find invalid shortcuts, hallucinate lemmas, hand-wave details, and
  claim success prematurely — constraints cannot mark code until it passes
- memory of failure (not just success) matters for genuine research
  productivity, and is unusual in benchmark-driven systems

Autoprover is being restarted as a Cosheaf tool harness. It borrows the
paper's workspace-first shape, but should not implement a separate
co-mathematician database or scheduler before the Cosheaf artifact model is
settled.

Design commitments:

- persistent mathematical workspace through Cosheaf
- native Coflat Markdown artifacts
- branches and PRs for active/proposed work
- issues, dependencies, labels, and milestones for planning
- reviews and comments for critique
- pluggable long-running model backends
- checkpoints and backend outputs preserved as Cosheaf artifacts

Missing or deliberately minimal:

- no implementation yet; this repo is design-only after the reset
- no separate durable task queue
- no hidden agent memory outside Cosheaf
- no provider-specific oracle architecture
- no long-running daemon until the tool model is stable
- no coordinator that allocates budget across multiple exploration threads
- no project-level planner beyond Cosheaf issues/dependencies/labels
- no debate, tournament, or cross-agent critique loop beyond Cosheaf review
- no hypothesis database beyond Cosheaf pages, issues, branches, PRs, and
  reviews
- no learned ranking, prioritization, or reinforcement-learning policy
- no formal-verification backend such as Lean

The next architectural step is design review: nail down the tool surface,
context-pack format, long-running backend job model, and Cosheaf artifact
mapping before writing implementation code.
