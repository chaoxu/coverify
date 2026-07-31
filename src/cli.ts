#!/usr/bin/env bun
import * as path from "node:path";
import { campaignExists, initCampaign, readJournal, readLedger } from "./campaign.js";
import { GateStore, recordStatement } from "./gates.js";
import { ROLE_NAMES, roleModelSpec, specLabel } from "./roles.js";
import { runCampaign } from "./harness.js";

function usage(): never {
  console.error(`usage:
  coverify prove "<exact statement>" [--dir campaign] [--agent-limit N] [--max-wakes N]
  coverify resume [--dir campaign] [--agent-limit N] [--max-wakes N]
  coverify status [--dir campaign]
  coverify amend [--dir campaign]   accept an explicit user amendment of STATEMENT.md

env: ANTHROPIC_API_KEY (+ OPENAI_API_KEY for openai/* roles — workers default to openai/gpt-5.6-sol@xhigh),
     COVERIFY_MODEL and per-role COVERIFY_MODEL_{COORDINATOR,WORKER,CRITIC,AUDITOR,CERTIFIER,RECONSTRUCTOR,COMPARATOR}
       as "provider/model[@thinking]" specs (base default anthropic/claude-opus-5@high),
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
  const keyOf = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" } as const;
  const missing = new Set<string>();
  for (const role of ROLE_NAMES) {
    const key = keyOf[roleModelSpec(role).provider];
    if (!process.env[key]) missing.add(`${key} (role ${role}: ${specLabel(roleModelSpec(role))})`);
  }
  if (missing.size > 0) {
    console.error(`missing API keys for configured role models:\n  ${[...missing].join("\n  ")}\n(fetch via: fleet-secret get <app>/<name>, or re-point the role with COVERIFY_MODEL_*)`);
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

switch (command) {
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
  default:
    usage();
}
