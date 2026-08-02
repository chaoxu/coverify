/**
 * Coverify extension for interactive pi sessions (redesign phase 3, the
 * boundary layer): open a campaign directory in vanilla pi and get
 *
 * `run_script` — coverify's supervised batch runner (process-group
 * leadership, shared wall/RSS caps, survivor sweep, exit reaper) in place
 * of raw bash, scoped to the current directory. Campaign inspection needs
 * no dedicated tool: pi's own read/ls/grep cover the ledgers, and
 * `coverify status`/`trace`/`turns` exist for the terminal.
 *
 * This is the manual-poking surface only. The full harness — gates,
 * verification cadence, dispatch, promotion — requires the coverify CLI;
 * nothing here can write trusted state.
 *
 * Load in interactive pi via an extensions dir or `extensionFactories`:
 *   import coverify from ".../coverify/src/pi-extension.ts";
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runScriptTool } from "./roles.js";

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
}
