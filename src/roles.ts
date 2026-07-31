import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Type } from "typebox";

const OUTPUT_LIMIT = 50_000;
const BASH_TIMEOUT_MS = Number(process.env.COVERIFY_BASH_TIMEOUT_MS ?? 600_000);

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

export interface WriteScope {
  /** Subtrees this role's bash may write. Reads are unrestricted. */
  allow: string[];
  /** Subtrees/files denied even inside an allowed subtree (deny wins). */
  deny: string[];
}

function sbplLiteral(p: string): string {
  return `"${fs.realpathSync.native(p).replace(/"/g, '\\"')}"`;
}

/**
 * Wrap a bash command in an OS write-sandbox (macOS sandbox-exec; SBPL rules
 * are last-match-wins, so denies are declared after allows). Reads stay
 * unrestricted — this narrows the tool surface, it adds no policy. On
 * non-darwin platforms the command runs unsandboxed and callers must treat
 * write confinement as instructed-only.
 */
export function sandboxedCommand(command: string, scope: WriteScope): { file: string; args: string[] } {
  if (process.platform !== "darwin") {
    return { file: "bash", args: ["-c", command] };
  }
  const allows = [
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(literal "/dev/null")',
    ...scope.allow.filter((p) => fs.existsSync(p)).map((p) => `(subpath ${sbplLiteral(p)})`),
  ].join(" ");
  const denyEntries = scope.deny
    .filter((p) => fs.existsSync(p))
    .map((p) => `(subpath ${sbplLiteral(p)}) (literal ${sbplLiteral(p)})`)
    .join(" ");
  const profile =
    `(version 1) (allow default) (deny file-write* (subpath "/")) (allow file-write* ${allows})` +
    (denyEntries ? ` (deny file-write* ${denyEntries})` : "");
  return { file: "sandbox-exec", args: ["-p", profile, "bash", "-c", command] };
}

export function bashTool(cwd: string, scope: WriteScope): AgentTool {
  return {
    name: "bash",
    label: "Bash",
    description:
      `Run a bash command. Working directory: ${cwd}. Writes are OS-sandboxed to your assigned ` +
      `directories. Each command has a ${Math.round(BASH_TIMEOUT_MS / 60000)}-minute limit — this bounds one ` +
      "shell command, not your turn; route genuinely long computations through the scheduler front door.",
    parameters: Type.Object({
      command: Type.String({ description: "Command to run" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) =>
      new Promise((resolve) => {
        const { file, args } = sandboxedCommand((params as { command: string }).command, scope);
        execFile(
          file,
          args,
          { cwd, timeout: BASH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
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
  /** Give the role bash at this cwd with this write scope. */
  bash?: { cwd: string; scope: WriteScope };
  extraTools?: AgentTool[];
  modelId: string;
  models: Models;
}

/**
 * Run one fresh, ephemeral role instance. Every role — coordinator wake,
 * worker, idea-gate critic, hostile auditor, reconstructor, comparator — is a
 * new Agent with no shared history. What each instance can see is decided by
 * the bundle its caller builds; the journal records supplied inputs and which
 * restrictions are platform-enforced versus instructed.
 */
export async function runRole(run: RoleRun): Promise<string> {
  const session = createRoleSession(run);
  return session.ask(run.prompt);
}

export interface RoleSession {
  ask(prompt: string): Promise<string>;
  /** Rough context size in tokens (chars/4 over the message history). */
  approxTokens(): number;
}

/**
 * A persistent role session: the same Agent instance across multiple asks,
 * accumulating context like a live harness session does. Used for the
 * coordinator, which stays resident until its context cap — the analog of
 * running the skill in Codex/Claude Code until compaction. Single-shot roles
 * (workers, critics, verifiers) go through runRole and never reuse a session.
 */
export function createRoleSession(run: Omit<RoleRun, "prompt"> & { prompt?: string }): RoleSession {
  const tools = run.bash ? [bashTool(run.bash.cwd, run.bash.scope)] : [];
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
  return {
    async ask(prompt: string): Promise<string> {
      await agent.prompt(prompt);
      return finalText(agent);
    },
    approxTokens(): number {
      let chars = 0;
      for (const m of agent.state.messages) chars += JSON.stringify(m).length;
      return Math.round(chars / 4);
    },
  };
}

/** Role charges. Each states only the role's scope; policy comes from the contract above it. */
export const CHARGES = {
  coordinator: `You are the campaign coordinator for one wake of an ongoing proof-search campaign.
You are the sole ledger writer. Prefer dispatching packets over doing extended proof work inline.
Tools beyond bash: dispatch_worker, dispatch_gate_critic, request_verification, record_promotion
(the only way to append to PROVED.md), and declare_campaign_state (pause/complete). Your bash
working directory is the campaign directory; edit the ledgers per the contract. STATEMENT.md,
PROVED.md, and the harness journal are write-protected. End the wake with your decisions recorded
in the ledgers and CURRENT_FRONTIER.md consistent with them.`,
  worker: `You are one exploration worker. You receive one packet with one finite mathematical
deliverable. Work only that packet. You may use bash in your assigned evidence directory; scratch
work may be edited freely, but never edit a file you have already cited or reported — semantic
changes to citable artifacts get a new revision-suffixed filename. Return a conclusion-first
report: the deliverable — a proved lemma, explicit construction, counterexample/certificate — or
the precise failing implication with evidence. Status reports and vague optimism are not
deliverables.`,
  gateCritic: `You are a fresh idea-gate critic. You receive only the frozen target, promoted
premises, one proposed mechanism, and its claimed first nontrivial implication. Your VERY FIRST
line must be exactly one of: IDEA PASS / IDEA FAIL / IDEA REPAIR. Then give the justification the
contract requires for that verdict.`,
  hostileAuditor: `You are stage 1 of the verification cadence: a fresh hostile auditor. You receive
the exact candidate revision, its statement, declared dependencies, and the current PROVED.md so
you can check what is actually promoted. Refute the candidate. Your VERY FIRST line must be exactly
VERDICT: PASS or VERDICT: FAIL; then the smallest concrete gap (on FAIL) or what you checked.`,
  reconstructor: `You are stage 2a of the verification cadence: a fresh no-context reconstructor.
You receive only the statement, high-level key ideas, allowed sources, and promoted premises — not
the candidate proof. Produce an end-to-end reconstruction using only that bundle. Do not give a
verdict; output the reconstruction itself, complete enough to be compared against the candidate.`,
  comparator: `You are stage 2b of the verification cadence: a fresh comparator. You receive an
independent reconstruction and the candidate's statement, conclusions, and declared dependencies.
Map the reconstruction to every conclusion and declared dependency of the candidate. Use the
frozen statement and the candidate's declared contract; do not invent a stronger output requirement
and fail the candidate for omitting it. Your VERY FIRST line must be exactly VERDICT: PASS or
VERDICT: FAIL; then the mapping (on PASS) or the concrete mismatch (on FAIL).`,
} as const;
