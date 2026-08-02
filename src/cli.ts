#!/usr/bin/env bun
import * as path from "node:path";
import { campaignExists, initCampaign, readJournal, readLedger } from "./campaign.js";
import { CLAUDE_BRIDGE_ID } from "./claude-bridge.js";
import { GateStore, recordStatement } from "./gates.js";
import {
  buildModels,
  cliBackendCommand,
  isCliProvider,
  ROLE_NAMES,
  roleModelSpec,
  specLabel,
} from "./roles.js";
import { runCampaign } from "./harness.js";
import { writeTrace } from "./trace.js";
import { campaignTurns } from "./turns.js";

function usage(): never {
  console.error(`usage:
  coverify prove "<exact statement>" [--dir campaign] [--agent-limit N] [--max-wakes N]
  coverify resume [--dir campaign] [--agent-limit N] [--max-wakes N]
  coverify status [--dir campaign]
  coverify trace [--dir campaign] [--out file] [--format html|perfetto]
                                    render the journal as a timeline: a self-contained HTML page,
                                    or Chrome Trace Event JSON for ui.perfetto.dev
  coverify turns [--dir campaign] [--session substr]
                                    per-turn telemetry derived from the session trees (sizes/usage/
                                    gaps/stopReason, no content); without --session, one summary
                                    line per session; with it, TurnRecord JSONL on stdout
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

function parseFlags(args: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const value = args[i + 1];
      if (value === undefined) usage();
      flags.set(a.slice(2), value);
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
  return v === undefined ? undefined : Number(v);
}

async function prove(resume: boolean): Promise<void> {
  // Auth preflight: a provider is usable via an env API key or a stored
  // OAuth subscription credential (coverify login <provider>).
  const models = await buildModels();
  const missing = new Set<string>();
  const { spawnSync } = await import("node:child_process");
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
    let ok = false;
    if (isCliProvider(provider)) {
      ok = spawnSync("which", [cliBackendCommand(provider).split(/\s+/)[0]]).status === 0;
    } else {
      try {
        ok = (await models.getAuth(provider)) !== undefined;
      } catch {
        ok = false;
      }
    }
    if (!ok) missing.add(`${provider} (role ${role}: ${specLabel(roleModelSpec(role))})`);
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
  const synthesis = await runCampaign({
    campaignDir: dir,
    userAgentLimit: optionalInt("agent-limit"),
    maxWakes: optionalInt("max-wakes"),
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
  case "status": {
    if (!campaignExists(dir)) {
      console.error(`no campaign at ${dir}`);
      process.exit(1);
    }
    console.log(readLedger(dir, "STATEMENT.md"));
    console.log(readLedger(dir, "CURRENT_FRONTIER.md"));
    const tail = readJournal(dir).slice(-10);
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
    const format = flags.get("format") ?? "html";
    if (format !== "html" && format !== "perfetto") usage();
    const out = writeTrace(dir, flags.get("out"), format);
    console.error(
      `[coverify] trace written: ${out}` +
        (format === "perfetto" ? " — open it at https://ui.perfetto.dev (parsed locally in the browser)" : ""),
    );
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
            (u.costUSD ? ` cost=$${u.costUSD.toFixed(2)}` : ""),
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
