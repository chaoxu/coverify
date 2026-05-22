# autoprover

This repository is intentionally design-only for now.

The previous Python proof harness has been removed. The project is being
restarted as a Codex tool harness for Cosheaf, and implementation should wait
until the design is nailed down.

## Direction

Cosheaf is the durable workspace: pages, branches, pull requests, reviews,
issues, labels, comments, notifications, search, and backlinks. The current
Cosheaf implementation is Forgejo-backed, but autoprover should treat Cosheaf
as the only workspace interface.

The design target:

- durable state lives in Cosheaf artifacts
- local state is only for currently running processes
- Codex uses tools over Cosheaf rather than a separate workflow database
- model backends are pluggable: scripts, CLIs, API wrappers, or remote jobs
- the first oracle backend is a Codex `gpt-5.5` / `xhigh` text-in/text-out
  wrapper, with Claude and Antigravity-style wrappers possible later
- backend calls may run as simple scripts with logs and timeout wrappers; add
  job state only when detached or parallel execution exists
- useful backend/oracle/Codex outputs become reviewed knowledge PRs
- each bounded or long-running run leaves durable progress in Cosheaf so later
  runs start from what was learned

## Documents

- [Design](docs/design.md): canonical tool-harness design, including Cosheaf
  mapping, context packs, review, runs, jobs, progress, and build order.
- [Coflat Primer](docs/coflat-primer.md): markdown/document-format context.
- [References And Future Notes](docs/references.md): paper-inspired design
  lessons and future learning notes.

## Current State

There is no runnable package, CLI, test suite, or scripts in this repository.
That is deliberate. The next step is design review, not implementation.
