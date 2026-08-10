# Driving coverify from another agent

For an agent that runs coverify as a tool. If you are an agent *modifying*
coverify, read `AGENTS.md` instead.

Coverify runs an adversarial proof search over one frozen mathematical
statement: models propose and work routes, and a candidate that looks finished
is attacked by four fresh instances, one of which is denied sight of it and
must derive the result independently. Survivors are recorded with the content
hash of the exact artifact verified.

It is a CLI over a directory of Markdown files. There is no server, no daemon,
no API. Everything below is `bun run src/cli.ts <verb>` and reading files. The
protocol being enforced is `contract/math-proof-search-launcher.md` in this
repository; `docs/design.md` maps every enforcement to its clause.

## The shape of the thing

One campaign resolves **one frozen statement**. The statement is hashed, and
every verification verdict is bound to that hash, so you cannot widen the
question mid-campaign and keep the verdicts. Changing it is `amend`, and it is
recorded.

A campaign runs until stopped. It has no completion timer, no agent ceiling,
and no wall-clock limit on thinking — deliberately. If you want it bounded, you
bound it: `--max-wakes N`.

## Starting and steering

```bash
bun run src/cli.ts prove "<exact statement>" --dir <campaign>
bun run src/cli.ts status --dir <campaign>
bun run src/cli.ts resume --dir <campaign>
bun run src/cli.ts stop   --dir <campaign>
bun run src/cli.ts say "<guidance>" --dir <campaign>
bun run src/cli.ts amend  --dir <campaign>
```

`prove` blocks for the life of the campaign. To supervise rather than babysit,
run it with `--max-wakes N`, inspect, then `resume`. `stop` sends SIGTERM to
the lock-holding process, which reaps the CLI subprocesses it spawned.

`say` is the steering channel. Messages are delivered into the coordinator's
running turn within about a second, or at its next wake if it is idle. Delivery
is at-least-once: a turn that fails leaves the message queued rather than
losing it.

Delivered messages are journaled and replayed. A directive survives both an
in-place compaction and a full session rebuild, because the harness re-sends
standing guidance on any prompt that rebuilds context rather than relying on it
still being in the conversation. Guidance you gave at wake 3 still applies at
wake 40.

What `say` does **not** do is change the target. It is guidance, not a
statement amendment — the coordinator is told so in both delivery paths. If the
question itself needs to change, use `amend`, which re-freezes and re-hashes.

## Reading a campaign without running it

Every one of these is read-only and safe against a live campaign:

```bash
bun run src/cli.ts status   --dir <campaign>    # phase, live agents, pending messages
bun run src/cli.ts outcomes --dir <campaign>    # verdicts, repair depth, promotions
bun run src/cli.ts spend    --dir <campaign>    # tokens by lane, role, model
bun run src/cli.ts limits   --dir <campaign>    # rate-limit headroom
bun run src/cli.ts turns    --dir <campaign>    # per-turn sizes and usage
```

The files themselves are the better read for most questions. `PROVED.md`,
`FAILED.md`, `REGISTRY.md`, `CURRENT_FRONTIER.md` and `EVIDENCE/` are plain
Markdown and always current — the harness writes them as it goes.

`.coverify/journal.jsonl` is the append-only event mirror if you want to
reconstruct what happened. One JSON object per line.

## Rules that will bite you

**Never edit a campaign's files directly.** Verification records are bound to
content hashes. Editing an artifact does not invalidate a verdict loudly — it
makes the record unverifiable. If you want a statement changed, use `amend`.
`PROVED.md` has exactly one legitimate writer (`record_promotion`, inside the
harness); direct writes are denied by the OS, not by convention.

**Do not treat a `PROVED.md` entry as a checked theorem.** The entry's prose is
written by the coordinator and is not mechanically checked against the proof it
cites. Verify the claim by reading the artifact the entry names, whose hash is
on the entry. This is the single most likely way to draw a wrong conclusion
from a coverify campaign.

**Do not run two harnesses on one campaign.** A run holds
`.coverify/lock.json` for its life. A second run would mint colliding handle
ids and gate against an incomplete record. A stale lock is taken over
automatically and the takeover is journaled.

**Two campaigns do not share results.** A promoted result from another campaign
is an imported theorem: cite it by path and re-verify its hypotheses where you
use it. There is deliberately no project-level index of promoted results —
that would be a second proof-state system, and the two would disagree.

## Interpreting what you find

A campaign with zero promotions is not necessarily a failed campaign.
`FAILED.md` is the load-bearing artifact for a search that did not close: it
records which routes died and why, which is what stops the next campaign
re-walking them.

`outcomes` splits verification spend by whether the revision ever promoted. A
high never-promoted share is normal for hard statements and is the number to
watch across campaigns rather than within one.

When quoting cost, quote per lane. Lanes bill to different provider accounts,
and one lane's `input` may include cached tokens where another's excludes
them, so a cross-lane total is not a currency. `spend` refuses to sum them,
and so should you. `docs/journal-shape.md` rule 1 states the convention; the
refusal was bought by a measurement that came out 27× wrong while three
independent-looking estimators agreed to within 0.05%.

## Environment

`bun` is the only runtime. Model access is per role — see `docs/models.md`.
Campaign state lives in the campaign directory; credentials and the
out-of-campaign gate store live under `~/.config/coverify` and
`~/.local/state/coverify` (XDG-respecting; `COVERIFY_STATE_DIR` overrides the
gate store).

`bun run src/cli.ts --help` lists every environment knob, generated from the
registry so the list cannot drift from the code. Defaults live at their read
sites and are not printed.
