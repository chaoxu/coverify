# Coverify

Coverify attacks one precise mathematical statement with a team of language
models, and leaves behind a record you can check.

It exists because a language model asked for a proof will produce one, and the
wrong ones read exactly like the right ones. Coverify's answer is not a better
prover — it is an adversarial process around the prover, and a record of what
that process actually did.

You write the statement in a file. Coverify runs a search: fresh model
sessions propose routes, work them out, and record what failed and why. When a
candidate proof looks finished, it goes through four separate sessions, none
of which sees the others' work:

1. A **hostile audit** by a model from a different vendor, asked to break the
   proof. Its verdict can kill the candidate.
2. A **bundle certification** checking that the summary handed to the next
   stage does not smuggle the proof through. A failure here sends the summary
   back for rewriting; the candidate is untouched.
3. A **blind reconstruction** — a session given the statement and the declared
   dependencies but not the proof, asked to derive the result itself. It
   returns no verdict.
4. A **comparison** mapping that independent derivation against the
   candidate's route and conclusions. Its verdict is the second that counts.

Promotion needs stages 1 and 4 to pass on the exact bytes of the candidate.
The reconstruction's value is that stage 4 has something to compare against
that was not written by looking at the proof.

The search does not stop on its own. It runs until you stop it, or until it
declares itself finished with at least one result on record.

## What this is not

**Nothing here is machine-checked.** No Lean, no proof assistant.
Verification is adversarial reading by language models. What a promoted result
means, stated exactly: a hostile audit from a different model family failed to
break it, and an independent derivation of the same statement was judged to
match it. That filter catches the confident nonsense a model reviewing its own
work waves through. It is not a proof of correctness, and a result that clears
it can still be wrong.

Three specific things to distrust, all recorded in `docs/design.md`'s honesty
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
- **The reconstructor's blindness is checked, not sealed.** The harness
  refuses to dispatch a reconstruction whose prompt contains the candidate
  text, comparing with whitespace collapsed so a re-wrapped copy cannot slip
  through. That is a real check and it catches the leak that actually happens
  — a coordinator pasting the proof into the "key ideas". What it does not do
  is stop a reconstructor from opening the file: the default reconstructor is
  a `codex` subprocess with read access to the disk, and its isolation from
  the candidate is an instruction. Treat the blind reconstruction as strong
  evidence, not as a sealed experiment.

What *is* enforced by the operating system: code that a technician runs goes
through a sandbox — `sandbox-exec` on macOS, Landlock and seccomp on Linux —
confined to its own directory. If that sandbox binary is missing, coverify
degrades to instructed-only confinement and says so on stderr.

## Running one

You need [Bun](https://bun.sh). The default setup wants **two** subscriptions
— ChatGPT and Claude — because the hostile audit deliberately runs on a
different vendor's model from the one that wrote the candidate. You can point
every role at one provider (see `docs/models.md`), and you lose the
cross-family check by doing so.

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

Two brakes. `--agent-limit N` caps concurrent workers and **defaults to 6**;
`--agent-limit 0` removes the cap. `--max-wakes N` stops after N coordinator
turns so you can look before spending more, and has no default.

There is no wall-clock timeout on thinking, ever. A reasoner that needs forty
minutes gets forty minutes. The only time limits in the system apply to
scripts a technician runs, not to proof work.

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
whether the search is spending well. On one recent campaign `outcomes`
reported 34 revisions entering verification and 5 promoted, at a median of 4
verification rounds per revision and a worst case of 12 — a revision going
round twelve times is the kind of thing that changes how you set up the next
campaign.

These readers live in `src/telemetry/`. Delete that folder and the lines in
`src/cli.ts` that import it and the harness still proves theorems, still
records what it spent, and loses these three commands along with the per-stage
breakdown they read. A check fails if anything else ever reaches into it.

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
itself. It is never shown the candidate, so it has nothing to agree with, and
the harness refuses to dispatch it if the proof text appears in its prompt. A
comparison step then maps its route against the candidate's. This is the only
stage that can catch an error the candidate's own framing makes invisible —
and the one whose isolation rests partly on instruction, as above.

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
