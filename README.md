# Coverify

Coverify attacks one precise mathematical statement with a team of language
models, and leaves behind a record you can check.

It exists because a language model asked for a proof will produce one, and the
wrong ones read exactly like the right ones. Coverify's answer is not a better
prover — it is an adversarial process around the prover, and a record of what
that process actually did.

You write the statement in a file. Coverify runs a search: instances propose
routes, work them out, and record what failed and why. When a candidate proof
looks finished, four fresh instances try to break it — one of them working
blind, reconstructing the result from the statement alone without ever seeing
the candidate. A candidate that survives all four is written to `PROVED.md`,
with the exact bytes it was verified against.

The search does not stop on its own. It runs until you stop it, or until it
declares itself finished with at least one result on record.

## What this is not

**Nothing here is machine-checked.** There is no Lean, no Coq, no proof
assistant. Verification is adversarial reading by language models. The
strongest honest description of a promoted result is: *four fresh instances
tried to break this and failed, one of them without being allowed to see it.*
That is a real filter — it catches the confident nonsense that a single model
reviewing its own work does not — and it is not a proof of correctness.

Two specific things to distrust, both recorded in `docs/design.md`'s honesty
ledger rather than hidden:

- **The promoted statement text is not checked against the proof.** The
  coordinator writes the `PROVED.md` entry, and nothing mechanically verifies
  that the sentence it wrote is what the candidate actually establishes. An
  over-claim is *auditable* — the entry carries the verified artifact and its
  content hash — not prevented. Read the artifact before you believe the
  entry.
- **The dependency list is instructed, not enforced.** A candidate declares
  what it relies on. The hostile auditor is shown `PROVED.md` so it can catch
  a false declaration, but nothing stops one from being made.

What *is* enforced by the operating system rather than by instruction: the
blind reconstructor genuinely cannot read the candidate, and every role can
only write inside the directory it was given. Those are filesystem
permissions, not promises in a prompt.

## Running one

You need [Bun](https://bun.sh) and a subscription to at least one model
provider. The defaults spawn the vendors' own CLIs — `codex` on a ChatGPT
subscription for most roles, `claude` on a Claude subscription for the hostile
audit, so that every candidate gets read by a model family that did not write
it.

```bash
bun install
bun run src/cli.ts login openai-codex        # ChatGPT subscription

bun run src/cli.ts prove "Every 3-connected planar graph has a ..." --dir campaign
```

That creates `campaign/` and starts working. It will run for hours. Ctrl-C is
always safe — state is on disk, and any compute it spawned is killed with it.

```bash
bun run src/cli.ts status --dir campaign     # where it is now
bun run src/cli.ts resume --dir campaign     # continue after a stop
bun run src/cli.ts say "the LP relaxation route is a dead end" --dir campaign
```

`say` reaches the coordinator inside its current turn, usually within a
second. Use it the way you would interrupt a student at a whiteboard.

Two optional brakes, both off unless you set them: `--agent-limit N` caps
concurrent workers, `--max-wakes N` stops after N coordinator turns so you can
inspect before spending more. Coverify imposes no limits of its own — no agent
ceiling, and no wall-clock timeout on thinking.

## What you get

The campaign directory is plain Markdown, readable without coverify:

```
campaign/
  STATEMENT.md          the frozen target — changing it takes an explicit `amend`
  PROVED.md             results that survived verification, with content hashes
  FAILED.md             routes that died, and why — the most useful file here
  CURRENT_FRONTIER.md   what it is attacking now
  REGISTRY.md           every claim and its status
  PROCESS_LESSONS.md    what the search learned about itself
  EVIDENCE/             every artifact: candidates, audits, reconstructions
```

`FAILED.md` is worth reading even when nothing is proved. A campaign that
spends a day killing six plausible routes has told you something, and told it
in a form you can check.

The statement is frozen on purpose. Every verification record is bound to the
statement's hash, so a verdict cannot silently become a verdict about a
different question. Changing your mind about the target is an explicit act:
`coverify amend`.

## Cost

Runs bill against your model subscriptions, not a metered API account, so the
constraint you hit is a rate-limit window rather than a bill.

```bash
bun run src/cli.ts limits --dir campaign     # how much of the window is left
bun run src/cli.ts spend --dir campaign      # where the tokens went
bun run src/cli.ts outcomes --dir campaign   # what the tokens bought
```

`limits` is the one to watch during a campaign. The others are for working out
whether the search is spending well — on a recent campaign, `outcomes` showed
34 revisions entering verification and 5 promoted, at a median of 4 repair
rounds each, which is the kind of thing that changes how you set a campaign up
next time.

These readers live in `src/telemetry/` and can be deleted outright. The
harness runs without them; you just stop getting token numbers.

## Why it is built this way

You can already point a frontier model at a hard statement and ask it to prove
something. What you get back is a confident write-up whose errors are exactly
as fluent as its correct steps, and no way to tell which is which.

The usual answer is to ask a second model to check the first. That is weaker
than it sounds: a reviewer shown a finished proof tends to follow its
narrative, and models from the same family share the same blind spots. So
coverify does three things instead.

**It withholds the proof from one verifier.** The reconstructor is given the
statement and the declared dependencies, and asked to derive the result
independently. It is not asked to agree — it cannot see anything to agree
with. A comparison step then maps its route against the candidate's. This is
the only stage that can catch an error the candidate's own framing makes
invisible.

**It crosses model families.** The hostile audit runs on a different vendor's
model from the one that wrote the candidate, so a shared failure mode has to
survive two architectures rather than one.

**It writes the rules down and enforces them in code.** The protocol coverify
follows is a document in this repository —
`contract/math-proof-search-launcher.md` — covering what a verifier may see,
when a verdict may be reused, what a promotion requires. Every enforcement in
the code maps to a clause in that document, and `docs/design.md` carries the
table mapping them. A check fails if the two drift apart. Rules written only
into prompts erode; these cannot.

The goal is verified results per token spent, not results per hour. Efficiency
here means not re-reading a ledger the coordinator already has, not re-paying
for a verification stage whose inputs are byte-identical. It never means
searching less or verifying less — verification spend counts inside the
budget, and shipping a false theorem costs more than shipping nothing.

The campaign directory is the protocol's own layout, so a Claude Code or Codex
session can open a campaign and continue it by hand, and coverify can pick up
where a hand-run session left off.

## For developers and agents

`AGENTS.md` — working on coverify. `docs/agent-operator.md` — driving coverify
from another agent. `docs/design.md` — every enforcement mapped to the
contract clause it comes from, plus the state diagrams and threat model.
`docs/models.md` — per-role model routing and provider auth.

```bash
bun run check    # typecheck, contract conformance, and the enforcement tests
```
