/** Manual-poking surface for interactive pi sessions: opening a campaign
 *  directory in vanilla pi gets coverify's supervised `run_script` in place of
 *  raw bash. Nothing here can write trusted state — gates, verification cadence,
 *  dispatch, and promotion require the coverify CLI. Load via an extensions dir
 *  or `extensionFactories`: import coverify from ".../src/pi-extension.ts". */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runScriptTool } from "./workspace.js";

export default function coverifyExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();

  // Same AgentTool the technician role uses, adapted to the extension
  // ToolDefinition shape (extra ctx arg ignored).
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
