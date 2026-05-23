# autoprover

This repository is being rebuilt as a CLI-first Codex tool harness for
Cosheaf. The previous proof harness was removed; v1 now contains a small
Cosheaf HTTP client, backend runner wrappers, and one end-to-end proof
workflow.

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

The first runnable surface is a Python CLI package under `src/autoprover`.
Use `PYTHONPATH=src python3 -m autoprover --help` from this checkout.

Implemented commands:

- `login`: exchange Cosheaf username/password for an API token.
- `create-workspace`: create a new Cosheaf workspace/project; defaults to
  `--default-md-format coflat`.
- Primitive Cosheaf operations for Codex-as-operator runs: `set-member`,
  `tree`, `read-file`, `create-branch`, `write-file`, `open-pr`, `review-pr`,
  and `merge-pr`.
- `prove-infinite-primes`: build a context pack, call a backend oracle, write
  `infinite-primes.md` on a branch, open a PR, optionally review and merge it,
  then verify the proof through Cosheaf.

Common environment variables:

```bash
COSHEAF_API_URL=http://localhost:3030/api/v1
COSHEAF_TOKEN=...
COSHEAF_USERNAME=...
COSHEAF_PASSWORD=...
COSHEAF_REVIEW_TOKEN=...
AUTOPROVER_BACKEND=codex
AUTOPROVER_CODEX_MODEL=gpt-5.5
AUTOPROVER_CODEX_REASONING_EFFORT=xhigh
```

Local checks:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests
PYTHONPATH=src python3 -m autoprover --help
```
