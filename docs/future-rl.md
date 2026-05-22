# Future Learning Notes

This document is not a v1 requirement. It records how the design can avoid
closing off future learning or evaluation work while the project is reset as a
Cosheaf tool harness.

The previous version described autoprover as a proof-writing harness with a
JSONL trace schema. That conflicts with the current design in two ways:

- the repo is design-only and has no trace implementation
- durable workflow state should live in Cosheaf artifacts, not in a private
  learning log

The compatible replacement idea is: if future implementation records traces,
they should be derived from or linked to Cosheaf artifacts.

Useful future records may include:

- the issue, branch, PR, review, page, or comment that triggered a run
- the context pack sent to Codex or a model backend
- the backend name and invocation metadata
- the raw backend answer or Codex output
- the checkpoint comment written after the run
- whether the related PR merged, changed, closed, or stayed open
- labels such as `grade:*`, `sig:*`, `needs-human`, or `abstain`
- follow-up issue/PR/review ids created from the run

Learning or evaluation could later use these records for:

- comparing context-pack strategies
- deciding when to call a stronger backend
- predicting which branches or PRs are worth continuing
- calibrating reviewers or oracle backends
- studying failed attempts preserved in Cosheaf

Non-goals for the design phase:

- no RL policy
- no learned scheduler
- no hidden long-term model memory
- no trace schema that becomes a second source of truth

The design requirement is only this: future implementation should make
important run outputs recoverable from Cosheaf artifacts, with any local trace
data treated as an index or audit log over those artifacts.
