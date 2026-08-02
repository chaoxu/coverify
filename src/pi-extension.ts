/**
 * Coverify extension for interactive pi sessions (redesign phase 3, the
 * boundary layer): open a campaign directory in vanilla pi and get
 *
 *   1. `run_script` — coverify's supervised batch runner (process-group
 *      leadership, shared wall/RSS caps, survivor sweep, exit reaper) in
 *      place of raw bash, scoped to the current directory; and
 *   2. `campaign_status` — a read-only inspector over the campaign ledgers
 *      and journal.
 *
 * This is the inspection/manual-poking surface only. The full harness —
 * gates, verification cadence, dispatch, promotion — requires the coverify
 * CLI; nothing here can write trusted state.
 *
 * Load in interactive pi via an extensions dir or `extensionFactories`:
 *   import coverify from ".../coverify/src/pi-extension.ts";
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { promotedStatementsView, readJournal, readLedger } from "./campaign.js";
import { runScriptTool } from "./roles.js";

function head(text: string, lines: number): string {
  const parts = text.split("\n");
  return parts.slice(0, lines).join("\n") + (parts.length > lines ? "\n…" : "");
}

export default function coverifyExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();

  // Supervised script runner: same AgentTool the technician role uses,
  // adapted to the extension ToolDefinition shape (extra ctx arg ignored).
  const supervised = runScriptTool(cwd, { allow: [cwd], deny: [] });
  pi.registerTool({
    name: supervised.name,
    label: supervised.label ?? "Run script (supervised)",
    description: supervised.description,
    parameters: supervised.parameters,
    executionMode: "sequential",
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) =>
      (supervised.execute as (id: string, p: unknown, s?: AbortSignal, u?: unknown) => Promise<unknown>)(
        toolCallId,
        params,
        signal,
        onUpdate,
      ),
  } as unknown as ToolDefinition);

  pi.registerTool({
    name: "campaign_status",
    label: "Campaign status",
    description:
      "Read-only summary of a coverify proof-search campaign directory: statement head, " +
      "current frontier, promoted theorem headings, and the journal tail. Never writes.",
    parameters: Type.Object({
      dir: Type.Optional(Type.String({ description: "Campaign directory (default: current directory)" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId: string, params: unknown) => {
      const d = path.resolve((params as { dir?: string }).dir ?? cwd);
      if (!fs.existsSync(path.join(d, "STATEMENT.md"))) {
        return { content: [{ type: "text" as const, text: `no campaign at ${d}` }], details: {} };
      }
      const promoted = promotedStatementsView(d);
      const promotedHeads = (promoted.match(/^## .*/gm) ?? []).join("\n") || "(no promotions)";
      const tail = readJournal(d)
        .slice(-8)
        .map((e) => JSON.stringify(e).slice(0, 160))
        .join("\n");
      const text =
        `# Statement (head)\n${head(readLedger(d, "STATEMENT.md"), 20)}\n\n` +
        `# CURRENT_FRONTIER\n${head(readLedger(d, "CURRENT_FRONTIER.md"), 60)}\n\n` +
        `# Promoted entries\n${promotedHeads}\n\n# Journal tail\n${tail}`;
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  } as unknown as ToolDefinition);
}
