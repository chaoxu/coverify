/**
 * Registers npm `pi-claude-bridge` as a plain pi-ai provider so tool-loop
 * roles can run on the Claude subscription. The bridge runs Claude Code with
 * `tools: []` + strict MCP config, so the model sees only pi-supplied tools
 * and coverify's write confinement is unchanged. Billing transport only; no
 * campaign semantics here.
 *
 * The package ships as a pi TUI extension, so we activate it against a stub
 * that captures registerProvider() and adapt the def to pi-ai's Provider.
 */
import { spawnSync } from "node:child_process";

// Computed specifier: Bun resolves and runs the bridge's TypeScript source at
// runtime; tsc must not traverse it (foreign source, different TS version).
const BRIDGE_MODULE = "pi-claude-bridge" + "/src/index.ts";

export const CLAUDE_BRIDGE_ID = "claude-bridge";

type AnyProvider = {
  id: string;
  name: string;
  baseUrl?: string;
  auth: unknown;
  getModels(): readonly unknown[];
  stream(model: unknown, context: unknown, options?: unknown): unknown;
  streamSimple(model: unknown, context: unknown, options?: unknown): unknown;
};

function claudeBinaryPresent(): boolean {
  return spawnSync("which", ["claude"]).status === 0;
}

let cached: AnyProvider | undefined;

export async function claudeBridgeProvider(): Promise<AnyProvider> {
  if (cached) return cached;
  const mod = (await import(BRIDGE_MODULE)) as { default: (pi: unknown) => void };
  let capturedId: string | undefined;
  let capturedDef: any;
  // The extension only calls on/registerProvider/registerTool at activation;
  // session events never fire outside the pi TUI.
  mod.default({
    on() {},
    registerTool() {},
    registerProvider(id: string, def: unknown) {
      capturedId = id;
      capturedDef = def;
    },
  });
  if (!capturedId || !capturedDef?.streamSimple || !Array.isArray(capturedDef.models)) {
    throw new Error("pi-claude-bridge activation did not register a usable provider");
  }
  const id = capturedId;
  const def = capturedDef;
  // The bridge's catalog entries omit provider/api/baseUrl (pi's registry
  // fills them); complete them to full pi-ai Model records.
  const catalog = def.models.map((m: Record<string, unknown>) => ({
    ...m,
    provider: id,
    api: def.api,
    baseUrl: def.baseUrl ?? id,
  }));
  cached = {
    id,
    name: "Claude Code bridge (subscription)",
    baseUrl: def.baseUrl ?? id,
    // Ambient auth: configured iff `claude` is on PATH and logged in, the
    // same condition the claude-cli verdict backend uses.
    auth: {
      apiKey: {
        name: "claude binary (Claude Code login)",
        check: async () =>
          claudeBinaryPresent() ? { type: "api_key" as const, source: "claude binary" } : undefined,
        resolve: async () =>
          claudeBinaryPresent()
            ? { auth: { apiKey: def.apiKey ?? "not-used" }, source: "claude binary" }
            : undefined,
      },
    },
    getModels: () => catalog,
    stream: (m, c, o) => def.streamSimple(m, c, o),
    streamSimple: (m, c, o) => def.streamSimple(m, c, o),
  };
  return cached;
}
