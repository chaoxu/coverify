#!/usr/bin/env bun
import * as path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  campaignExists,
  initCampaign,
  peekUserMessages,
  queueUserMessage,
  gateOf,
  readCampaignLock,
  readJournal,
  readLedgerOrNote,
} from "./campaign.js";
import { CLAUDE_BRIDGE_ID } from "./claude-bridge.js";
import { GateStore, acceptedStatementHash, recordStatement, statementHash } from "./gates.js";
import {
  buildModels,
  providerUsable,
  ROLE_NAMES,
  roleModelSpec,
  sameFamilyAsAuditor,
  specLabel,
} from "./providers.js";
import { runCampaign } from "./harness.js";
// The whole measurement extension, imported only here: delete src/telemetry/
// and these lines and the harness still proves theorems.
import { campaignTurns } from "./telemetry/turns.js";
import { campaignSpend, formatSpend } from "./telemetry/spend.js";
import { campaignOutcomes, formatOutcomes } from "./telemetry/outcomes.js";
import { campaignLimits, formatLimits } from "./telemetry/limits.js";
import { knobUsage, validateKnobs } from "./knobs.js";
import { JournalTelemetryContext } from "./telemetry/context.js";

function usage(explicit = false): never {
  const out = explicit ? console.log : console.error;
  out(`usage:
  coverify prove "<exact statement>" [--dir campaign] [--agent-limit N] [--max-wakes N] [--no-computation]
  coverify resume [--dir campaign] [--agent-limit N] [--max-wakes N] [--no-computation]
                                    (--agent-limit defaults to 6 workers — user policy 2026-08-08; 0 = unlimited)
  coverify stop [--dir campaign]    SIGTERM the lock-holding harness (reaper kills its CLI tree)
  coverify status [--dir campaign]
  coverify spend [--dir campaign] [--run <runId>]
                                    per-lane, per-role token totals from the journal;
                                    refuses cross-meter sums and roll-ups
  coverify limits [--dir campaign] [--run <runId>]
                                    rate-limit window occupancy and burn rate — the constraint
                                    that actually ends campaigns (subscription runs are not
                                    metered in dollars)
  coverify outcomes [--dir campaign] [--run <runId>]
                                    what the spend bought: stage verdicts, repair-loop depth,
                                    and spend split by whether the revision ever promoted
  coverify turns [--dir campaign] [--session substr]
                                    per-turn telemetry derived from the session trees (sizes/usage/
                                    gaps/stopReason, no content); without --session, one summary
                                    line per session; with it, TurnRecord JSONL on stdout
  coverify say "<message>" [--dir campaign]
                                    send a verbatim message to the coordinator: steered into
                                    its running turn within ~1s, else delivered at the next wake
  coverify amend [--dir campaign]   accept an explicit user amendment of STATEMENT.md
  coverify login <provider>         subscription OAuth (anthropic = Claude Pro/Max,
                                    openai-codex = ChatGPT; credential -> ~/.config/coverify/auth.json)
  coverify logout <provider>

auth: defaults need 'coverify login openai-codex' (ChatGPT subscription) plus the 'codex' and
       'claude' binaries — OpenAI GPT-5.6 Sol everywhere except the hostile auditor, which
       stays on claude-cli/opus; API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)
       only for api-provider role overrides
env: every knob below is generated from src/knobs.ts, so this list cannot drift from
     the code the way a hand-written one did. Each knob's DEFAULT lives at its one
     read site in the code; unset means that site's value governs the run, and the
     run stamp records only the knobs you actually set.
${knobUsage()}`);
  process.exit(explicit ? 0 : 2);
}

/** Every flag this CLI accepts, declared so `strict: true` can stop the run on
 *  an unknown one: a typo like `--max-wake 40` otherwise runs UNBOUNDED and
 *  silently. Everything is a string except the one boolean, so `--agent-limit 0`
 *  still reaches agentLimit()'s unlimited sentinel. node:util.parseArgs is built
 *  into Bun; commander, yargs-parser and mri add nothing over it. */
const FLAG_SPEC = {
  dir: { type: "string" },
  "agent-limit": { type: "string" },
  "max-wakes": { type: "string" },
  "no-computation": { type: "boolean" },
  run: { type: "string" },
  session: { type: "string" },
} as const;

function parseFlags(args: string[]): { flags: Map<string, string>; positional: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: FLAG_SPEC as unknown as ParseArgsConfig["options"],
      allowPositionals: true,
      strict: true,
    });
    // A declared flag stranded AFTER `--` is silently positional, which for
    // `prove` means initialising a campaign in the wrong directory and spending
    // there. Refuse it — a hint in an error message is not a check.
    const stranded = positionals.filter((p) => Object.keys(FLAG_SPEC).some((f) => p === `--${f}`));
    if (stranded.length > 0) {
      console.error(
        `${stranded.join(", ")} appears after -- and would be read as text, not as a flag.\n` +
          "Put every flag before the -- separator.",
      );
      process.exit(2);
    }
    return {
      flags: new Map(
        Object.entries(values)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ),
      positional: positionals,
    };
  } catch (e) {
    // A statement beginning with "-" is legitimate here, and strict mode
    // rejects a positional that looks like a flag. The hint must put flags
    // BEFORE the `--` separator: everything after it is positional, so
    // `prove -- "-1 is not X" --dir work` drops --dir and spends in the wrong
    // directory.
    const why = e instanceof Error ? e.message : String(e);
    console.error(
      `${why}\nIf an argument begins with "-", put every flag FIRST and the argument last, ` +
        `after --:\n  coverify prove --dir work -- "-1 is not expressible as ..."`,
    );
    process.exit(2);
  }
}

const [command, ...rest] = process.argv.slice(2);
// An explicit help request is not a usage error: it exits 0 on stdout, so
// `coverify --help | less` shows something and `coverify --help && ...` runs on.
if (command === "--help" || command === "-h" || command === "help") usage(true);
if (!command) usage();
const { flags, positional } = parseFlags(rest);
const dir = path.resolve(flags.get("dir") ?? "campaign");

function optionalInt(name: string): number | undefined {
  const v = flags.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  // NaN passes every `!== undefined` check and loses every comparison, so a
  // typo'd limit means *no* limit while the coordinator is told one is in force.
  // agentLimit() below is the one exception, taking "0" as unlimited.
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${name} must be a positive whole number (got: ${v})`);
    process.exit(2);
  }
  return n;
}

/** Worker cap: default 6 per campaign, an explicit user policy (2026-08-08), not
 *  a harness-invented ceiling — that provenance is what satisfies the launcher's
 *  no-invented-limits rule. `--agent-limit 0` requests unlimited; every other
 *  non-positive value still hard-stops via optionalInt. */
function agentLimit(): number | undefined {
  const v = flags.get("agent-limit");
  if (v === undefined) return 6;
  if (v === "0") return undefined;
  return optionalInt("agent-limit");
}

/** Every read-only verb needs a campaign; one message, one exit code. */
function requireCampaign(): void {
  if (campaignExists(dir)) return;
  console.error(`no campaign at ${dir}`);
  process.exit(1);
}

async function prove(resume: boolean): Promise<void> {
  // Before anything is spent. The per-call readers stay lenient on purpose —
  // runTimeoutMs() runs while a tool executes and a throw there would kill a
  // live campaign — so the hard-fail happens here.
  try {
    validateKnobs();
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(2);
  }
  // Cheap refusals first: a missing campaign or a missing statement does not
  // depend on model access, and running the auth preflight ahead of them made
  // `resume --dir /nowhere` report an auth failure on any machine without
  // credentials — including a fresh clone running `bun run check`.
  if (resume && !campaignExists(dir)) {
    console.error(`no campaign at ${dir}`);
    process.exit(1);
  }
  if (!resume && !positional[0]) usage();

  // Auth preflight: a provider is usable via an env API key or a stored OAuth
  // subscription credential (coverify login <provider>).
  const models = await buildModels();
  const missing = new Set<string>();
  for (const role of ROLE_NAMES) {
    const provider = roleModelSpec(role).provider;
    // claude-bridge supports exactly one live session; concurrent ones
    // cross-contaminate. Coordinator only.
    if (provider === CLAUDE_BRIDGE_ID && role !== "coordinator") {
      console.error(
        `claude-bridge is coordinator-only (single concurrent session); re-point ${role} via COVERIFY_MODEL_* (e.g. claude-cli/opus)`,
      );
      process.exit(1);
    }
    if (!(await providerUsable(models, provider))) {
      missing.add(`${provider} (role ${role}: ${specLabel(roleModelSpec(role))})`);
    }
  }
  if (missing.size > 0) {
    console.error(
      `no usable auth for configured role providers:\n  ${[...missing].join("\n  ")}\n` +
        "fix by: 'coverify login anthropic|openai-codex' (subscription OAuth); OR installing and " +
        "logging into the vendor binary for a *-cli provider (run `claude` or `codex` once); OR an " +
        "API key env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY); OR re-pointing the " +
        "role with COVERIFY_MODEL_<ROLE>. See docs/models.md.",
    );
    process.exit(1);
  }
  // Not a refusal: a same-family audit is still an audit, and refusing here
  // would invent a policy the user did not set. But the cross-family property
  // is the audit's whole point, so a run that has quietly lost it says so.
  const sameFamily = sameFamilyAsAuditor();
  if (sameFamily.length > 0) {
    console.error(
      `[coverify] WARNING: the hostile auditor (${specLabel(roleModelSpec("hostileAuditor"))}) is the ` +
        `same model as: ${sameFamily.join(", ")}.\n` +
        "  A candidate written there is audited by its own model, so the audit no longer crosses\n" +
        "  model families. Re-point one of them with COVERIFY_MODEL_* or COVERIFY_FAMILY_* to restore it.",
    );
  }

  // Parsed BEFORE the campaign is created: validating at the call site left a
  // full campaign skeleton on disk behind a `--max-wakes abc` typo, which
  // contradicts the refuse-before-doing-anything posture everything else here
  // keeps.
  const maxWakes = optionalInt("max-wakes");
  const agents = agentLimit();

  if (!resume) {
    initCampaign(dir, positional[0]!);
    recordStatement(new GateStore(dir), dir, "init");
    console.error(`[coverify] campaign initialized at ${dir}`);
  }
  // Reasoning-only is a per-CAMPAIGN user policy (design.md rule 3), so a resume
  // inherits it from the last run's stamp. Read from the GATE STORE, never the
  // role-adjacent in-tree journal, where a forged trailing runStart line could
  // silently re-arm technicians.
  let noComputation = flags.get("no-computation") === "true";
  if (resume && !noComputation) {
    const last = new GateStore(dir).all().findLast((e) => e.runStart === true);
    if (last?.noComputation === true) {
      noComputation = true;
      console.error("[coverify] reasoning-only policy inherited from the prior run (--no-computation)");
    }
  }
  const synthesis = await runCampaign({
    telemetry: (store) => new JournalTelemetryContext(store),
    campaignDir: dir,
    userAgentLimit: agents,
    maxWakes,
    noComputation,
  });
  console.log(synthesis);
}

/** Providers that hold their own OAuth credential. The CLI-backed providers
 *  are deliberately absent: `claude-cli` and `codex-cli` ride the vendor
 *  binary's own login, so `login claude-cli` is not a thing to do — it used to
 *  reach pi-ai and surface a raw `ModelsError` stack, from the very command the
 *  auth preflight tells you to run. */
const OAUTH_PROVIDERS = ["anthropic", "openai-codex"] as const;

async function oauth(action: "login" | "logout"): Promise<void> {
  const provider = positional[0];
  if (!provider) usage();
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
    console.error(
      `${provider} does not use coverify's OAuth store. Valid: ${OAUTH_PROVIDERS.join(", ")}.\n` +
        "claude-cli and claude-bridge use the `claude` binary's own login (run `claude` once);\n" +
        "codex-cli uses the `codex` binary's (`coverify login openai-codex` covers the API lane);\n" +
        "api providers use ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.",
    );
    process.exit(2);
  }
  const models = await buildModels();
  if (action === "logout") {
    await models.logout(provider);
    console.error(`[coverify] logged out of ${provider}`);
    return;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await models.login(provider, "oauth", {
      prompt: async (p: { type: string; message: string; options?: readonly { id: string; label: string }[] }) => {
        if (p.type === "select" && p.options) {
          p.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
          const n = Number(await rl.question(`${p.message} (1-${p.options.length}): `)) - 1;
          return p.options[n]?.id ?? "";
        }
        return rl.question(`${p.message}: `);
      },
      notify: (event: { type: string; message?: string; url?: string; userCode?: string; verificationUri?: string }) => {
        if (event.type === "auth_url") console.log(`Open: ${event.url}`);
        else if (event.type === "device_code") console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
        else if (event.message) console.log(event.message);
      },
    });
    console.error(`[coverify] logged in to ${provider}; credential saved to ~/.config/coverify/auth.json`);
  } finally {
    rl.close();
  }
}

switch (command) {
  case "login":
    await oauth("login");
    break;
  case "logout":
    await oauth("logout");
    break;
  case "prove":
    await prove(false);
    break;
  case "resume":
    await prove(true);
    break;
  case "amend": {
    requireCampaign();
    // `amend` accepts whatever STATEMENT.md now says — you edit the file, then
    // run this. Recording a "new revision" when the bytes did not change is a
    // lie that also invalidates nothing, so refuse: an operator who ran amend
    // without editing needs to know the edit did not happen.
    const store = new GateStore(dir);
    const current = statementHash(dir);
    if (acceptedStatementHash(store) === current) {
      console.error(
        `STATEMENT.md is unchanged (sha256 ${current.slice(0, 12)}); nothing to amend.\n` +
          "Edit STATEMENT.md first, then run amend to accept the new text and re-freeze it.",
      );
      process.exit(1);
    }
    recordStatement(store, dir, "explicit user amendment");
    console.error(
      "[coverify] amendment accepted: new statement revision recorded; earlier completion evidence " +
        "is invalidated per the contract (verifications are hash-bound and will not carry over).",
    );
    break;
  }
  case "say": {
    requireCampaign();
    const message = positional[0];
    if (!message) usage();
    queueUserMessage(dir, message);
    console.error(
      `[coverify] message queued (${peekUserMessages(dir).length} pending); ` +
        "steered into the coordinator's running turn within ~1s, else delivered at its next wake",
    );
    break;
  }
  case "stop": {
    // Signal the lock-holding harness (issue #19: hand-hunted PIDs hit the zsh
    // wrapper). SIGTERM only; the reaper takes the CLI process groups with it.
    const { lockPath, held } = readCampaignLock(dir);
    if (held === undefined || typeof held.pid !== "number") {
      console.error(`no running campaign at ${dir} (no readable lock at ${lockPath})`);
      process.exit(1);
    }
    // Pid-reuse guard: a lock left by a SIGKILLed harness can point at a
    // recycled pid, so check the command line before signaling it.
    const { spawnSync } = await import("node:child_process");
    const cmdline = spawnSync("ps", ["-p", String(held.pid), "-o", "command="]).stdout?.toString() ?? "";
    if (!/coverify|cli\.ts/.test(cmdline)) {
      console.error(
        `lock-holder pid ${held.pid} is ${cmdline.trim() === "" ? "not running" : `an unrelated process (${cmdline.trim().slice(0, 80)})`} — ` +
          "stale lock; next run reclaims it",
      );
      process.exit(1);
    }
    process.kill(held.pid, "SIGTERM");
    console.error(`[coverify] SIGTERM sent to campaign harness pid ${held.pid} (started ${held.startedAt})`);
    break;
  }
  case "status": {
    requireCampaign();
    const pending = peekUserMessages(dir);
    if (pending.length > 0) {
      console.log(`## Pending user messages (${pending.length}, next wake)\n`);
      for (const m of pending) console.log(`- ${m}`);
      console.log("");
    }
    console.log(readLedgerOrNote(dir, "STATEMENT.md"));
    console.log(readLedgerOrNote(dir, "CURRENT_FRONTIER.md"));
    const journal = readJournal(dir);
    // Verdict-permission records beside the verdicts: a FAIL followed by a PASS
    // on the same revision reads as verdict shopping without its rebuttal.
    const rebuttals = journal.map(gateOf).filter((g) => g?.kind === "rebuttal");
    if (rebuttals.length > 0) {
      const shown = rebuttals.slice(-10);
      console.log(
        `## Recorded rebuttals (${shown.length < rebuttals.length ? `last ${shown.length} of ` : ""}${rebuttals.length} — ` +
          "each sanctions one fresh attempt on an unchanged revision)\n",
      );
      for (const r of shown) {
        console.log(`- ${String(r?.ts ?? "").slice(0, 19)} ${r?.revision}: ${r?.artifact}`);
      }
      console.log("");
    }
    const tail = journal.slice(-10);
    if (tail.length > 0) {
      console.log("## Recent harness journal entries\n");
      for (const e of tail) console.log(JSON.stringify(e));
    }
    break;
  }
  case "spend": {
    requireCampaign();
    console.log(formatSpend(campaignSpend(dir, flags.get("run"))));
    break;
  }
  case "limits": {
    requireCampaign();
    console.log(formatLimits(campaignLimits(dir, flags.get("run"))));
    break;
  }
  case "outcomes": {
    requireCampaign();
    console.log(formatOutcomes(campaignOutcomes(dir, flags.get("run"))));
    break;
  }
  case "turns": {
    requireCampaign();
    const filter = flags.get("session");
    const sessions = campaignTurns(dir).filter(
      (s) => filter === undefined || s.file.includes(filter) || s.id.includes(filter),
    );
    if (sessions.length === 0) {
      console.error(filter === undefined ? "no sessions recorded" : `no session matches "${filter}"`);
      process.exit(1);
    }
    if (filter === undefined) {
      for (const s of sessions) {
        const u = s.usage;
        const hit = u.input + u.cacheRead > 0 ? u.cacheRead / (u.input + u.cacheRead) : 0;
        console.log(
          `${s.file}  messages=${s.turns.length} in=${u.input} out=${u.output} ` +
            `cacheRead=${u.cacheRead} cacheHit=${(hit * 100).toFixed(0)}%` +
            (u.reasoning !== undefined ? ` reasoning=${u.reasoning}` : ""),
        );
      }
    } else {
      for (const s of sessions) for (const t of s.turns) console.log(JSON.stringify(t));
    }
    break;
  }
  default:
    usage();
}
