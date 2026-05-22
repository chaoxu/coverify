# autoprover

This repository is intentionally design-only for now.

The previous Python proof harness has been removed. The project is being
restarted as a Codex tool harness for Cosheaf, and implementation should wait
until the design is nailed down.

## Direction

Cosheaf is the durable workspace: Forgejo-backed pages, branches, pull
requests, reviews, issues, labels, comments, notifications, search, and
backlinks. Autoprover should give Codex tools for operating on that workspace.

The design target:

- durable state lives in Cosheaf/Forgejo artifacts
- local state is only for currently running processes
- Codex uses tools over Cosheaf rather than a separate workflow database
- model backends are pluggable: scripts, CLIs, API wrappers, or remote jobs
- backend calls may run for a long time and need logs, heartbeat, timeout,
  cancellation, and links to Cosheaf artifacts
- backend/oracle results are recorded in issues, PRs, comments, or pages
- each bounded or long-running run leaves checkpoints so later runs start from
  what was learned

## Documents

- [Tool Harness Design](docs/prover-design.md): canonical design.
- [Architecture](docs/architecture.md): short-form architecture summary.
- [Coflat Primer](docs/coflat-primer.md): markdown/document-format context.
- [Paper Gap](docs/paper-gap.md): gaps against the agentic mathematics paper.
- [Future RL](docs/future-rl.md): possible trace/learning direction.
- [Superhuman Ideas](docs/superhuman-ideas.md): related external ideas.

## Current State

There is no runnable package, CLI, test suite, or scripts in this repository.
That is deliberate. The next step is design review, not implementation.
