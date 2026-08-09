# Coverify Agent Guidance

## The goal: cost-efficient proof search

Coverify exists to obtain verified mathematical results using as few tokens
as possible. The metric is verified-true output per billable token, and the
arbiter is the budget-matched A/B against the raw skill in `docs/design.md`
("Token-controlled A/B") — not wall-clock, not wake count, not artifact
volume.

The goal binds harness mechanics, never the search itself:

- In scope: what each role is made to read, how the ledgers are addressed,
  what a wake carries, what must be re-read after compaction, what is
  reused. A token not spent re-reading something the agent already has is
  the whole win.
- Out of scope, and still forbidden by rule 3 below: capping agents, timing
  out proof work, defaulting a budget the user did not set. Efficiency is
  never bought by searching less.
- Verification spend counts inside the budget and is never what gets cut.
  Shipping a false theorem costs more than shipping nothing.

Efficiency claims are measured, not asserted — quote before/after tokens or
context chars from real campaign sessions (`coverify turns`, the journal's
usage records), the way `docs/design.md` records its baselines. Follow
`docs/measurement-protocol.md` when you do: it fixes the unit conventions
(cached inside or beside input, reasoning inside output), requires the
three-way cross-check, and records why a token count is not a cost.

## The skill is the spec

Coverify enforces the `math-proof-search` launcher contract
(`~/kb/notes/agents/prompts/prompt-math-proof-search-launcher.md`). Before
changing harness behavior, read that contract. Three rules govern all code
here:

1. Every enforcement must trace to a launcher clause; keep the conformance
   table in `docs/design.md` in sync with the code.
2. Code that doesn't map to a clause must be semantics-invisible mechanics
   (scheduler, wake building, cache policy, journal) — removable without
   changing campaign behavior.
3. No invented policy defaults: no agent-count ceiling, no wall-clock
   timeouts on proof work, budgets only when the user sets them.

Role prompts embed the launcher's fenced block verbatim — never paraphrase
it. If the launcher file is unavailable, fail loudly; never substitute a
remembered version.

## Do not edit the canonical skill casually

Candidate skill improvements go in `docs/skill-feedback.md`, not into
`~/kb/notes/agents/skills/math-proof-search/`. The canonical skill is only
updated after live campaign evidence, and that edit happens in `~/kb` with
its own review.

## Keep campaigns out of this repo

A campaign is a folder elsewhere (the launcher's file layout). This repo is
the harness only. Domain-specific checkers or search tools belong in the
project folder — never added to this CLI. Roles have no shell: technicians
run scripts inside their own evidence directory via `run_script`.

Live campaigns sit under `~/research/<project>/campaigns/<date-slug>/`.
Inspect them read-only (`coverify status --dir`, the `.coverify/journal.jsonl`
gate mirror, `EVIDENCE/audits/`); never edit a campaign's files from here —
verification records are content-hash-bound and an edit breaks them.

## Reuse of verifier responses

Any reuse of a verifier response must be keyed on the content hash of every
input that verifier saw and content-bound to its saved artifact
(`priorReusableRecord` with its `requireStranded` policy flag). Bundle-keyed reuse was
built once and removed (6997036) for violating "Never reuse a verifier
response that influenced the repair" — do not reintroduce a shortcut keyed
on anything less than the full input set.

## Workflow

Issues live on the Gitea remote (`origin` = jupiter); use `tea`. Evidence
for skill-level changes goes to `docs/skill-feedback.md` first (see above);
harness lessons go in the `docs/design.md` conformance table and roadmap.

## Style

TypeScript on Bun; keep the tool small. Checks: `bun run check` (tsc, launcher conformance, and the
enforcement tests in `tests/`). Prefer
enforcing a rule in `gates.ts` over restating it in a prompt, and prefer
prompt text quoted from the launcher over new prose.
