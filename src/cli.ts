#!/usr/bin/env bun
import * as path from "node:path";
import { campaignExists, initCampaign, readJournal, readLedger } from "./campaign.js";
import { runCampaign } from "./harness.js";

function usage(): never {
  console.error(`usage:
  coverify prove "<exact statement>" [--dir campaign] [--agent-limit N] [--max-wakes N]
  coverify resume [--dir campaign] [--agent-limit N] [--max-wakes N]
  coverify status [--dir campaign]

env: ANTHROPIC_API_KEY (required for prove/resume), COVERIFY_MODEL (default claude-opus-5),
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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set (fetch via: fleet-secret get <app>/<name>)");
    process.exit(1);
  }
  if (!resume) {
    const statement = positional[0];
    if (!statement) usage();
    initCampaign(dir, statement);
    console.error(`[coverify] campaign initialized at ${dir}`);
  } else if (!campaignExists(dir)) {
    console.error(`no campaign at ${dir}`);
    process.exit(1);
  }
  const synthesis = await runCampaign({
    campaignDir: dir,
    modelId: process.env.COVERIFY_MODEL ?? "claude-opus-5",
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
