import { execFile } from "node:child_process";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Type } from "typebox";

const OUTPUT_LIMIT = 50_000;

export type Models = ReturnType<typeof createModels>;

export function buildModels(): Models {
  const models = createModels();
  models.setProvider(anthropicProvider());
  return models;
}

export function getModel(models: Models, modelId: string) {
  const model = models.getModel("anthropic", modelId);
  if (!model) {
    throw new Error(`unknown anthropic model id "${modelId}"; set COVERIFY_MODEL`);
  }
  return model;
}

function finalText(agent: Agent): string {
  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const m = agent.state.messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function bashTool(cwd: string): AgentTool {
  return {
    name: "bash",
    label: "Bash",
    description: `Run a bash command. Working directory: ${cwd}.`,
    parameters: Type.Object({
      command: Type.String({ description: "Command to run" }),
    }),
    executionMode: "sequential",
    // Launcher: no coordinator-created elapsed-time limit on proof work. The
    // 10-minute cap here bounds one shell command, not the agent's turn.
    execute: async (_id: string, params: unknown) =>
      new Promise((resolve) => {
        execFile(
          "bash",
          ["-c", (params as { command: string }).command],
          { cwd, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
          (error: Error | null, stdout: string, stderr: string) => {
            let out = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
            if (out.length > OUTPUT_LIMIT) out = out.slice(0, OUTPUT_LIMIT) + "\n[truncated]";
            if (error) out = `${out}\n[error: ${error.message}]`;
            resolve(toolText(out || "(no output)"));
          },
        );
      }),
  } as AgentTool;
}

export interface RoleRun {
  /** The full launcher contract text (verbatim), embedded in the system prompt. */
  contract: string;
  /** One-paragraph role charge appended after the contract. */
  charge: string;
  prompt: string;
  cwd?: string;
  extraTools?: AgentTool[];
  modelId: string;
  models: Models;
}

/**
 * Run one fresh, ephemeral role instance. Every role — coordinator wake,
 * worker, idea-gate critic, hostile auditor, reconstructor — is a new Agent
 * with no shared history. Blindness and minimal context are properties of the
 * bundle the caller builds, which the journal records per call.
 */
export async function runRole(run: RoleRun): Promise<string> {
  const tools = run.cwd ? [bashTool(run.cwd)] : [];
  if (run.extraTools) tools.push(...run.extraTools);
  const agent = new Agent({
    initialState: {
      systemPrompt: `The campaign contract below governs this work. Follow it exactly.\n\n<contract>\n${run.contract}\n</contract>\n\n${run.charge}`,
      model: getModel(run.models, run.modelId),
      thinkingLevel: "high",
      tools,
    },
    streamFn: run.models.streamSimple.bind(run.models),
  });
  await agent.prompt(run.prompt);
  return finalText(agent);
}

/** Role charges. Each states only the role's scope; policy comes from the contract above it. */
export const CHARGES = {
  coordinator: `You are the campaign coordinator for one wake of an ongoing proof-search campaign.
You are the sole ledger writer. You do not do proof work inline: compose packets and dispatch them.
Available tools beyond bash: dispatch_worker, dispatch_gate_critic, request_verification, cancel.
Your bash working directory is the campaign directory; edit ledgers per the contract.
End the wake with your decisions recorded in the ledgers and CURRENT_FRONTIER.md consistent with them.`,
  worker: `You are one exploration worker. You receive one packet with one finite mathematical
deliverable. Work only that packet. You may use bash in your assigned evidence directory; write any
artifact as a new file there (never edit existing files). Return a conclusion-first report: the
deliverable — a proved lemma, explicit construction, counterexample/certificate — or the precise
failing implication with evidence. Status reports and vague optimism are not deliverables.`,
  gateCritic: `You are a fresh idea-gate critic. You receive only the frozen target, promoted
premises, one proposed mechanism, and its claimed first nontrivial implication. Return exactly one
verdict line first — IDEA PASS, IDEA FAIL, or IDEA REPAIR — then the justification the contract
requires for that verdict.`,
  hostileAuditor: `You are stage 1 of the verification cadence: a fresh hostile auditor. You receive
the exact candidate revision, its statement, and declared dependencies. Refute it. Return PASS or
the smallest concrete gap, verdict line first (VERDICT: PASS / VERDICT: FAIL).`,
  reconstructor: `You are stage 2 of the verification cadence: a fresh no-context reconstructor. You
receive only the statement, high-level key ideas, allowed sources, and promoted premises — not the
candidate proof. Produce an end-to-end reconstruction using only that bundle. Begin with
VERDICT: PASS or VERDICT: FAIL, then the reconstruction (or the exact point of failure).`,
} as const;
