# Coverify Agent Guidance

## Two Contracts: Exploration And Mathematical Resolution

Do not multiply modes when one output contract is enough. Coverify should use
two contracts:

- **Exploratory response** for normal chat, source-grounded answers, route
  exploration, issue triage, status summaries, conjecture shaping, and packaging
  resolution targets. This contract is flexible: it may answer directly, explain
  what the current sources support, propose next routes, or identify the exact
  theorem, construction, counterexample search, certificate, bound, or subclaim
  that should be sent to a stronger tool. It must label speculation and cite or
  otherwise ground repo-specific claims.
- **Mathematical resolution** for one exact hard mathematical target. This
  contract is strict: exact statement, exact hypotheses, allowed context,
  relevant failed routes, and one requested output from the canonical
  resolution-artifact vocabulary in `src/coverify/math_contract.py`. It is fine
  to call this tool the "prover" as shorthand, but proving is only one possible
  output. Use the strongest suitable prover/resolver here, and verify
  independently. Do not brainstorm inside a mathematical-resolution call. If
  the target requires a particular known fact, theorem, construction, or proof
  method, include that requirement explicitly; the verifier should fail outputs
  that solve a nearby target or ignore the forced method.

A "solve this issue" task starts as an exploratory response unless the issue
already contains a clean resolution target. Exploration may call tools freely,
including the prover/resolver, computation, source readers, and verifiers. What
matters is that anything sent to the user or written as durable state is
verified and honestly labeled using the relevant status or canonical
resolution-artifact vocabulary. Ordinary chat answers are not a third mode; they
are exploratory responses with a direct-answer target.

## Prefer Agentic Preparation Over More Workflow Code

When planning Coverify work, do not respond to uncertainty by adding another
deterministic Python planning layer by default. If the task requires judgment,
context selection, route choice, or deciding what evidence matters, prefer an
agentic preparation step or oracle call that can inspect the allowed material.

The Coverify tooling should stay small:

- Python tools expose source bundles, Cosheaf operations, backend invocation,
  audit trails, validation, and verification gates.
- Agents and oracles decide which context matters, which route to try, and how
  to frame a mathematical question.
- Local code validates agent output mechanically, for example by checking file
  paths, line ranges, citations, schemas, hashes, and verifier verdicts.
- Add deterministic code only when the behavior is stable, repeatable, and
  genuinely simpler than asking an agent to inspect the allowed context.

For repo-snapshot chat specifically, the preferred flow is:

```text
question + thread + allowed source-bundle root
  -> agentic prepare_context over the bundle files
  -> mechanical range extraction and citation validation
  -> exploratory response, or packaged mathematical resolution when requested
  -> independent verifier with the matching contract
  -> response/comment
```

Avoid rebuilding a large planner in Python. The right boundary is agentic
preparation with mechanical validation, not ever more pre-gather heuristics.

## Keep Project Runs Separate From Harness Changes

A mathematical project should live in a Cosheaf workspace plus a local project
workdir. Start day-to-day Codex sessions in that project workdir, not in the
Coverify checkout. Use `PROJECT.md` for orientation and issues or task pages
for concrete work. Let the project-local agent use Coverify skills and the
scaffolded `bin/coverify` wrapper, but do not treat the Coverify repo as the
project memory.

If a project run exposes a Coverify bug or missing generic capability, pause
that project step and fix Coverify as harness work in this repo. Run the
Coverify checks before resuming the project, and record in the project issue
which Coverify revision or local change was used when the result depends on it.
If only the scaffolded wrappers need to be refreshed, rerun `scaffold-workdir`
with `--refresh-tools`; do not overwrite project docs just to update
`bin/coverify`.

If the project needs a domain-specific checker, score script, or search tool,
put that code in the golden project repo or a companion project repo and point
the issue to it. Do not add project-specific research commands to the default
Coverify CLI.

## GitHub Publication Is Snapshot-Only

Do not mirror this checkout's Git history to GitHub by default. The lab history
may contain private, project-specific, or obsolete research material. GitHub
publication should use a fresh public snapshot commit built from the current
clean tree after privacy scans pass.

Keep lab continuity and public release separate:

- `jupiter`/lab remotes may keep the private operational history.
- GitHub receives only intentionally selected public files in a fresh snapshot.
- Never configure automatic push-to-both remotes unless the histories have been
  deliberately made identical and public-safe.
