# Architecture

Autoprover is being restarted as a Codex tool harness around Cosheaf.

Cosheaf/Forgejo is the durable workspace. Codex is the active operator.
External model backends are optional helpers: they may be simple scripts, API
wrappers, CLIs, or remote jobs. Oracle calls are one workflow over those
backends, where the harness sends one context string and records the answer
back into Cosheaf.

The canonical design is [`prover-design.md`](prover-design.md).

```text
Cosheaf
  source of truth for pages, branches, pull requests, reviews, issues,
  labels, milestones, comments, notifications, and merge state

Autoprover
  provides Codex tools over Cosheaf
  builds context packs
  runs pluggable model backends when useful
  tracks active long-running runs
  writes checkpoints and backend results back to Cosheaf
```

## Design Rule

If an agent action matters after the process exits, it must leave a
Cosheaf/Forgejo artifact.

Examples:

- accepted knowledge is a page merged to `main`
- active work is a branch
- proposed work is a pull request
- verification is a PR review or line comment
- backlog and subgoals are issues and dependencies
- run notes, oracle outputs, and handoffs are issue/PR comments
- state categories are labels

## Local State

Autoprover may keep local state only for currently running processes: run id,
backend name, status, heartbeat, timeout, log pointer, cancellation flag, and
links to Cosheaf artifacts. Durable workflow state belongs in Cosheaf.

## Tools

The first product surface should be tools for Codex, not a separate prover
application. Tool families:

- read/search pages and backlinks
- create/update issues and dependencies
- create/list branches
- write files on branches
- open/read/review/merge PRs
- add labels and comments
- build context packs
- run a backend and record the answer
- ask an oracle through a selected backend
- checkpoint progress

## Context

Context management is the core problem. A bounded run should gather the
objective, current artifacts, accepted facts, open hypotheses, relevant pages,
issues, PRs, reviews, failed attempts, current diff, constraints, and the exact
question for this run.

If the context summary is useful after the run, it should be written to
Cosheaf as a checkpoint comment or page. The harness should not rely on hidden
private memory to resume work.

## Trust

Autoprover does not decide what is golden. Cosheaf owns branch protection,
review records, merge state, issue state, and the shared human-visible history.

Backend output is advice or raw work product, not truth. Codex may use it,
reject it, or turn it into a PR/review/comment, but the raw answer and the
follow-up decision should be recorded in Cosheaf when they affect the work.
