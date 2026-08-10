# Driving coverify from another agent

For an agent that runs coverify as a tool. If you are an agent *modifying*
coverify, read `AGENTS.md` instead.

Coverify runs an adversarial proof search over one frozen mathematical
statement: models propose and work routes, and a candidate that looks finished
goes through four fresh sessions — a hostile audit, a bundle certification, a
blind reconstruction that is not shown the proof, and a comparison of that
reconstruction against the candidate. Two of those four issue a verdict that
can stop a promotion (the audit and the comparison). Survivors are recorded
with the content hash of the exact artifact verified.

It is a CLI over a directory of Markdown files. There is no server, no daemon,
no API. Everything below is `coverify <verb>` (after `bun link`; otherwise `coverify <verb>`) and reading files. The
protocol being enforced is `contract/math-proof-search-launcher.md` in this
repository; `docs/design.md` maps every enforcement to its clause.

## The shape of the thing

One campaign resolves **one frozen statement**. The statement is hashed, and
every verification verdict is bound to that hash, so you cannot widen the
question mid-campaign and keep the verdicts. Changing it is `amend`, and it is
recorded.

A campaign runs until stopped. There is no completion timer and no wall-clock
limit on proof work; the only timeouts apply to scripts a technician runs.
`--agent-limit` caps concurrent workers and defaults to **6** (`0` removes the
cap). `--max-wakes N` has no default and is how you bound a run for
supervision.

## Starting and steering

```bash
coverify prove "<exact statement>" --dir <campaign>
coverify status --dir <campaign>
coverify resume --dir <campaign>
coverify stop   --dir <campaign>
coverify say "<guidance>" --dir <campaign>
coverify amend  --dir <campaign>
```

`prove` blocks for the life of the campaign — hours. Do not wait on it in a
foreground tool call. Either run it with `--max-wakes N` so it returns after N
coordinator turns, or start it detached with output redirected to a file and
poll the campaign directory. `stop` sends SIGTERM to the lock-holding process,
which reaps the CLI subprocesses it spawned.

Exit codes: `0` success, `1` operational refusal (no campaign at `--dir`, no
lock to stop), `2` usage error (unknown flag, malformed value, missing
argument). A bad flag never runs unbounded — `--max-wake 40` is rejected
rather than silently ignored.

`say` is the steering channel. Messages are delivered into the coordinator's
running turn within about a second, or at its next wake if it is idle. Delivery
is at-least-once: a turn that fails leaves the message queued rather than
losing it.

Delivered messages are journaled and replayed. A directive survives both an
in-place compaction and a full session rebuild, because the harness re-sends
standing guidance on any prompt that rebuilds context rather than relying on it
still being in the conversation.

The replay is capped at the **20 most recent** directives (`standingGuidance`
in src/harness.ts). Past 20, the oldest silently stop being replayed. If a
constraint must hold for the whole campaign, it belongs in `STATEMENT.md` via
`amend`, not in the 21st `say`.

What `say` does **not** do is change the target. It is guidance, not a
statement amendment — the coordinator is told so in both delivery paths. If the
question itself needs to change, use `amend`, which re-freezes and re-hashes.

## Reading a campaign without running it

Every one of these is read-only and safe against a live campaign:

```bash
coverify status   --dir <campaign>    # pending messages, STATEMENT, frontier, last 10 events
coverify outcomes --dir <campaign>    # verdicts, repair depth, promotions
coverify spend    --dir <campaign>    # tokens by lane, role, model
coverify limits   --dir <campaign>    # rate-limit headroom
coverify turns    --dir <campaign>    # per-turn sizes and usage
```

The files themselves are the better read for most questions. `PROVED.md`,
`FAILED.md`, `REGISTRY.md`, `CURRENT_FRONTIER.md` and `EVIDENCE/` are plain
Markdown and always current — the harness writes them as it goes.

`.coverify/journal.jsonl` is the append-only event mirror if you want to
reconstruct what happened. One JSON object per line.

## Rules that will bite you

**Never edit a campaign's files directly** — with exactly one exception, below.
Verification records are bound to content hashes. Editing an artifact does not
invalidate a verdict loudly; it makes the record unverifiable.

The exception is `STATEMENT.md`, and it is a two-step workflow rather than a
command: **edit `STATEMENT.md`, then run `amend`.** `amend` takes no statement
argument — it accepts whatever the file now says, records a new statement
revision, and re-freezes. Running it without editing refuses and exits 1, so a
successful `amend` always means the target really moved.
`PROVED.md` has exactly one legitimate writer (`record_promotion`, inside the
harness). The coordinator's own write tool refuses it via an in-process scope
check; a technician's `run_script` is refused by the OS sandbox.

**Do not treat a `PROVED.md` entry as a checked theorem.** The entry's prose is
written by the coordinator and is not mechanically checked against the proof it
cites. Verify the claim by reading the artifact the entry names, whose hash is
on the entry.

Nor is the promotion machine-checked in the sense you might assume. It requires
two verdicts — a hostile audit and a comparison against a blind reconstruction
— on byte-identical inputs. The reconstruction's isolation from the candidate
is a prompt check plus an instruction, not a sandbox: the reconstructor is a
subprocess that can read the disk.

**Do not run two harnesses on one campaign.** A run holds
`.coverify/lock.json` for its life. A second run would mint colliding handle
ids and gate against an incomplete record. The lock carries a pid: a second
run probes it with `kill(pid, 0)`, throws if the holder is alive, and
otherwise reclaims the lock and journals the takeover. So `.coverify/lock.json`
plus a liveness check on its pid is how you tell a live campaign from an
abandoned one — no verb reports that directly.

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

`coverify --help` lists every environment knob, generated from the
registry so the list cannot drift from the code. Defaults live at their read
sites and are not printed.
