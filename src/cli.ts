#!/usr/bin/env bun
import * as path from "node:path";
import {
  campaignExists,
  initCampaign,
  peekUserMessages,
  queueUserMessage,
  gateOf,
  readCampaignLock,
  readJournal,
  readLedger,
} from "./campaign.js";
import { CLAUDE_BRIDGE_ID } from "./claude-bridge.js";
import { GateStore, recordStatement } from "./gates.js";
import {
  buildModels,
  providerUsable,
  ROLE_NAMES,
  roleModelSpec,
  specLabel,
} from "./providers.js";
import { runCampaign } from "./harness.js";
import { writeTrace } from "./trace.js";
import { campaignTurns } from "./turns.js";

function usage(): never {
  console.error(`usage:
  coverify prove "<exact statement>" [--dir campaign] [--agent-limit N] [--max-wakes N] [--no-computation]
  coverify resume [--dir campaign] [--agent-limit N] [--max-wakes N] [--no-computation]
                                    (--agent-limit defaults to 6 workers — user policy 2026-08-08; 0 = unlimited)
  coverify stop [--dir campaign]    SIGTERM the lock-holding harness (reaper kills its CLI tree)
  coverify status [--dir campaign]
  coverify trace [--dir campaign] [--out file]
                                    render the journal as a self-contained HTML timeline
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
env: per-role COVERIFY_MODEL_{COORDINATOR,REASONER,TECHNICIAN,CRITIC,AUDITOR,CERTIFIER,RECONSTRUCTOR,COMPARATOR}
       as "provider/model[@thinking]" specs (the only model override),
     COVERIFY_LAUNCHER_PATH (default ~/kb/notes/agents/prompts/prompt-math-proof-search-launcher.md)`);
  process.exit(2);
}

/** Flags that take no value (presence = true). */
const BOOLEAN_FLAGS = new Set(["no-computation"]);

function parseFlags(args: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, "true");
        continue;
      }
      const value = args[i + 1];
      if (value === undefined) usage();
      flags.set(name, value);
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const [command, ...rest] = process.argv.slice(2);
if (!command) usage();
const { flags, positional } = parseFlags(rest);
const dir = path.resolve(flags.get("dir") ?? "campaign");

function optionalInt(name: string): number | undefined {
  const v = flags.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  // NaN would pass every `!== undefined` check and lose every comparison, so a
  // typo'd limit silently meant *no* limit while the coordinator was still
  // told one was in force. This is the user's only budget control; a bad value
  // must stop the run, not disable itself. One documented exception routes
  // around this guard: agentLimit() below treats the literal "0" as the
  // unlimited sentinel before delegating here.
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${name} must be a positive whole number (got: ${v})`);
    process.exit(2);
  }
  return n;
}

/** Worker cap: default 6 per campaign — an explicit USER decision
 *  (Chao, 2026-08-08), not a harness-invented ceiling; the launcher's
 *  no-invented-limits rule is satisfied because the default's provenance is
 *  a recorded user policy, like the model defaults. `--agent-limit 0`
 *  explicitly requests unlimited — deliberately REVERSING 2853c9b, which
 *  rejected `0` when it meant "limit is zero, refuse every dispatch" (a
 *  silent footgun); the sentinel meaning is stated in the usage string,
 *  and every other non-positive value still hard-stops via optionalInt. */
function agentLimit(): number | undefined {
  const v = flags.get("agent-limit");
  if (v === undefined) return 6;
  if (v === "0") return undefined;
  return optionalInt("agent-limit");
}

async function prove(resume: boolean): Promise<void> {
  // Auth preflight: a provider is usable via an env API key or a stored
  // OAuth subscription credential (coverify login <provider>).
  const models = await buildModels();
  const missing = new Set<string>();
  for (const role of ROLE_NAMES) {
    const provider = roleModelSpec(role).provider;
    // claude-bridge supports exactly one live session; concurrent sessions
    // cross-contaminate (observed in testing). Coordinator only.
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
        "fix with an API key env var (fleet-secret get <app>/<name>), 'coverify login <provider>' " +
        "for subscription OAuth, or re-point the role with COVERIFY_MODEL_*",
    );
    process.exit(1);
  }
  if (!resume) {
    const statement = positional[0];
    if (!statement) usage();
    initCampaign(dir, statement);
    recordStatement(new GateStore(dir), dir, "init");
    console.error(`[coverify] campaign initialized at ${dir}`);
  } else if (!campaignExists(dir)) {
    console.error(`no campaign at ${dir}`);
    process.exit(1);
  }
  // Reasoning-only is a per-CAMPAIGN user policy (design.md rule 3), so a
  // resume inherits it from the last run's stamp. Read from the GATE STORE,
  // never the in-tree journal: the journal is role-adjacent, and on an
  // instructed-only confinement platform a forged trailing runStart line
  // could silently re-arm technicians (2026-08-09 architecture review).
  let noComputation = flags.get("no-computation") === "true";
  if (resume && !noComputation) {
    const last = new GateStore(dir).all().findLast((e) => e.runStart === true);
    if (last?.noComputation === true) {
      noComputation = true;
      console.error("[coverify] reasoning-only policy inherited from the prior run (--no-computation)");
    }
  }
  const synthesis = await runCampaign({
    campaignDir: dir,
    userAgentLimit: agentLimit(),
    maxWakes: optionalInt("max-wakes"),
    noComputation,
  });
  console.log(synthesis);
}

async function oauth(action: "login" | "logout"): Promise<void> {
  const provider = positional[0];
  if (!provider) usage();
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
    if (!campaignExists(dir)) {
      console.error(`no campaign at ${dir}`);
      process.exit(1);
    }
    recordStatement(new GateStore(dir), dir, "explicit user amendment");
    console.error(
      "[coverify] amendment accepted: new statement revision recorded; earlier completion evidence " +
        "is invalidated per the contract (verifications are hash-bound and will not carry over).",
    );
    break;
  }
  case "say": {
    if (!campaignExists(dir)) {
      console.error(`no campaign at ${dir}`);
      process.exit(1);
    }
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
    // Signal the lock-holding harness (issue #19: killing by hand-hunted PID
    // is error-prone — first attempt hit the zsh wrapper). SIGTERM only; the
    // reaper takes the CLI process groups down with it.
    const { lockPath, held } = readCampaignLock(dir);
    if (held === undefined || typeof held.pid !== "number") {
      console.error(`no running campaign at ${dir} (no readable lock at ${lockPath})`);
      process.exit(1);
    }
    // Pid-reuse guard: a lock left by a SIGKILLed harness can point at a
    // recycled pid — verify the command line looks like a coverify harness
    // before signaling an innocent process.
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
    if (!campaignExists(dir)) {
      console.error(`no campaign at ${dir}`);
      process.exit(1);
    }
    const pending = peekUserMessages(dir);
    if (pending.length > 0) {
      console.log(`## Pending user messages (${pending.length}, next wake)\n`);
      for (const m of pending) console.log(`- ${m}`);
      console.log("");
    }
    console.log(readLedger(dir, "STATEMENT.md"));
    console.log(readLedger(dir, "CURRENT_FRONTIER.md"));
    const journal = readJournal(dir);
    // Verdict-permission records beside the verdicts (skill-feedback
    // 2026-08-09): a FAIL followed by a PASS on the same revision is only
    // legible next to its recorded rebuttal — without this section the
    // contract's legitimate rebuttal lane reads as verdict shopping.
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
  case "trace": {
    if (!campaignExists(dir)) {
      console.error(`no campaign at ${dir}`);
      process.exit(1);
    }
    const out = writeTrace(dir, flags.get("out"));
    console.error(`[coverify] trace written: ${out}`);
    console.log(out);
    break;
  }
  case "turns": {
    if (!campaignExists(dir)) {
      console.error(`no campaign at ${dir}`);
      process.exit(1);
    }
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
