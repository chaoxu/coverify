# Skill feedback ledger

Candidate improvements to the canonical `math-proof-search` skill
(`~/kb/notes/agents/skills/math-proof-search/`), discovered while designing
this harness. **Policy: do not edit the canonical skill until this harness
has completed at least one real campaign.** The skill text is carefully
tuned; churning it on the basis of an unbuilt harness would be exactly the
kind of speculative change the skill itself warns against. Revisit this file
after the first live run.

## Deferred candidates

1. **Interop note (the only planned zero-risk edit).** One sentence in
   SKILL.md: a conformant harness (coverify 2.0) exists, uses the launcher's
   exact campaign file layout, and campaign directories are interchangeable —
   a skill session may resume a coverify campaign and vice versa. Blocked on:
   coverify actually shipping and demonstrating a resumed campaign in both
   directions.

2. **Ambient status instead of polling.** The launcher already forbids
   interrupting quiet workers, but says nothing about how the coordinator
   learns worker state. The harness pattern — status digest included in every
   wake, review wakes on long silence, no status queries — reduced
   token-waste and polling temptation in design analysis. If live skill runs
   show coordinators polling workers, add a sentence to the thin-coordinator
   adapter.

3. **Wake-shaped coordinator context.** The launcher's restart rule (reread
   statement + frontier + lessons + registry index only) is written for
   restarts; the harness applies it at *every* coordinator turn, which keeps
   coordinator context constant-size for the campaign's life. If live skill
   runs show coordinator context bloat, generalize the restart rule to a
   per-checkpoint context discipline.

4. **Explicit gate-verdict location.** The launcher says "record the packet
   and verdict when the route is selected" without naming where. The harness
   journals it and mirrors it in REGISTRY.md. If skill sessions scatter these
   records, name REGISTRY.md in the clause.

## Rejected candidates

- Numeric thresholds for "substantial wave" — prose judgment is the right
  form for a model-interpreted contract; the harness picks its own concrete
  threshold (second dispatch on a mechanism) and documents it as an
  implementation choice, not spec.
- Verification-panel sizes / pessimistic N-of-M language — the launcher's
  two-stage cadence is more specific than a vote count; nothing to add.
