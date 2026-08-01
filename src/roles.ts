import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { fileCredentialStore } from "./credentials.js";
import { claudeBridgeProvider } from "./claude-bridge.js";
import { Type } from "typebox";

const OUTPUT_LIMIT = 50_000;
const BASH_TIMEOUT_MS = Number(process.env.COVERIFY_BASH_TIMEOUT_MS ?? 600_000);

export type Models = ReturnType<typeof createModels>;

export async function buildModels(): Promise<Models> {
  // Persistent credential store: OAuth subscription logins (coverify login)
  // survive across runs; API-key env vars keep working unchanged.
  const models = createModels({ credentials: fileCredentialStore() });
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider());
  models.setProvider(googleProvider());
  // Subscription tool-loop transport (Agent SDK); see src/claude-bridge.ts.
  models.setProvider((await claudeBridgeProvider()) as Parameters<Models["setProvider"]>[0]);
  return models;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RoleName =
  | "coordinator"
  | "worker"
  | "gateCritic"
  | "hostileAuditor"
  | "bundleCertifier"
  | "reconstructor"
  | "comparator";

export interface ModelSpec {
  provider:
    | "anthropic"
    | "openai"
    | "openai-codex"
    | "google"
    | "claude-bridge"
    | "claude-cli"
    | "codex-cli"
    | "chatgpt-cli";
  modelId: string;
  thinking: ThinkingLevel;
}

export const ROLE_NAMES: RoleName[] = [
  "coordinator",
  "worker",
  "gateCritic",
  "hostileAuditor",
  "bundleCertifier",
  "reconstructor",
  "comparator",
];

const ROLE_ENV: Record<RoleName, string> = {
  coordinator: "COVERIFY_MODEL_COORDINATOR",
  worker: "COVERIFY_MODEL_WORKER",
  gateCritic: "COVERIFY_MODEL_CRITIC",
  hostileAuditor: "COVERIFY_MODEL_AUDITOR",
  bundleCertifier: "COVERIFY_MODEL_CERTIFIER",
  reconstructor: "COVERIFY_MODEL_RECONSTRUCTOR",
  comparator: "COVERIFY_MODEL_COMPARATOR",
};

/** All-Anthropic-on-subscription decision (user, 2026-07-31): every default
 *  role bills the Claude subscription. The coordinator's tool loop runs
 *  through claude-bridge (Agent SDK; official `claude` login) — bridge
 *  sessions cross-contaminate when concurrent, so claude-bridge is
 *  coordinator-only (enforced at preflight). Workers and the five
 *  single-shot verdict roles run through the official `claude -p` CLI:
 *  independent processes, safe in parallel, subscription-billed
 *  (third-party OAuth draws Extra Credits per current Anthropic billing).
 *  Every role is overridable per-role or globally. */
const ROLE_DEFAULTS: Partial<Record<RoleName, string>> = {
  coordinator: "claude-bridge/claude-opus-5@high",
  worker: "claude-cli/opus",
  gateCritic: "claude-cli/opus",
  hostileAuditor: "claude-cli/opus",
  bundleCertifier: "claude-cli/opus",
  reconstructor: "claude-cli/opus",
  comparator: "claude-cli/opus",
};

const BASE_DEFAULT = "anthropic/claude-opus-5@high";

/** Spec format: `provider/model[@thinking]`; bare model id means anthropic. */
export function parseModelSpec(spec: string): ModelSpec {
  const [modelPart, thinking = "high"] = spec.split("@");
  const slash = modelPart.indexOf("/");
  const provider = slash < 0 ? "anthropic" : modelPart.slice(0, slash);
  const modelId = slash < 0 ? modelPart : modelPart.slice(slash + 1);
  if (
    provider !== "anthropic" &&
    provider !== "openai" &&
    provider !== "openai-codex" &&
    provider !== "google" &&
    provider !== "claude-bridge" &&
    provider !== "claude-cli" &&
    provider !== "codex-cli" &&
    provider !== "chatgpt-cli"
  ) {
    throw new Error(`unknown provider "${provider}" in model spec "${spec}"`);
  }
  return { provider, modelId, thinking: thinking as ThinkingLevel };
}

/** Resolution: COVERIFY_MODEL_<ROLE> > role default > COVERIFY_MODEL > base. */
export function roleModelSpec(role: RoleName): ModelSpec {
  return parseModelSpec(
    process.env[ROLE_ENV[role]] ?? ROLE_DEFAULTS[role] ?? process.env.COVERIFY_MODEL ?? BASE_DEFAULT,
  );
}

export function specLabel(spec: ModelSpec): string {
  return `${spec.provider}/${spec.modelId}`;
}

function getModel(models: Models, spec: ModelSpec) {
  const model = models.getModel(spec.provider, spec.modelId);
  if (!model) {
    throw new Error(
      `unknown ${spec.provider} model id "${spec.modelId}"; check the COVERIFY_MODEL* spec ` +
        `(auth: ${{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", "openai-codex": "coverify login openai-codex", "claude-bridge": "claude binary (Claude Code login)", "claude-cli": "claude binary", "codex-cli": "codex binary", "chatgpt-cli": "chatgpt-cli binary (daemon must be running)" }[spec.provider]})`,
    );
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

export function toolText(text: string) {
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
function sandboxedCommand(command: string, scope: WriteScope): { file: string; args: string[] } {
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

function bashTool(cwd: string, scope: WriteScope): AgentTool {
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
  spec: ModelSpec;
  models: Models;
}

/**
 * Run one fresh, ephemeral role instance (single-shot roles: idea-gate
 * critic, hostile auditor, bundle certifier, reconstructor, comparator).
 * The coordinator and workers use createRoleSession directly. What each
 * instance sees is decided by the bundle its caller builds; the journal
 * records supplied inputs and which restrictions are platform-enforced
 * versus instructed.
 */
export async function runRole(run: RoleRun): Promise<string> {
  if (isCliProvider(run.spec.provider)) {
    if (run.bash || run.extraTools) {
      throw new Error("CLI backends support single-shot verdict roles only (no tools)");
    }
    return runCliRole(run.spec.provider, run.spec.modelId, `${systemText(run)}\n\n---\n\n${run.prompt}`);
  }
  const session = createRoleSession(run);
  return session.ask(run.prompt);
}

export function isCliProvider(p: string): p is keyof typeof CLI_BACKENDS {
  return p in CLI_BACKENDS;
}

/** Subscription-billed official CLIs as verdict-role backends. Command
 *  templates are env-overridable so CLI flag drift never needs a harness
 *  release; {model} and {out} are substituted. */
export const CLI_BACKENDS = {
  "claude-cli": { env: "COVERIFY_CLAUDE_CMD", cmd: "claude -p --model {model}", output: "stdout" },
  "codex-cli": {
    env: "COVERIFY_CODEX_CMD",
    cmd: "codex exec --model {model} --sandbox read-only --skip-git-repo-check --output-last-message {out} -",
    output: "outfile",
  },
  /** Chao's chatgpt.com daemon CLI (gitea chaoxu/chatgpt-cli): the only road
   *  to ChatGPT-Pro-only models (gpt-5.6-pro) — the deep one-shot prover.
   *  The daemon picks the actual model; the spec's modelId is a provenance
   *  label. Emits {ok, text, error} JSON on stdout. */
  "chatgpt-cli": { env: "COVERIFY_CHATGPT_CMD", cmd: "chatgpt-cli oracle --quiet --timeout 6000", output: "oracle-json" },
} as const;

export function cliBackendCommand(provider: keyof typeof CLI_BACKENDS): string {
  const backend = CLI_BACKENDS[provider];
  return process.env[backend.env] ?? backend.cmd;
}

function systemText(run: Pick<RoleRun, "contract" | "charge">): string {
  return `The campaign contract below governs this work. Follow it exactly.\n\n<contract>\n${run.contract}\n</contract>\n\n${run.charge}`;
}

/**
 * Run one single-shot role through an official subscription CLI. cwd is a
 * fresh empty temp dir; the CLI's own tools find nothing there
 * (instructed-only isolation — recorded honestly by callers). No timeout:
 * audit and reconstruction work is never clocked. Output comes from the
 * {out} file when the template names one (codex), else stdout (claude).
 */
function runCliRole(
  provider: keyof typeof CLI_BACKENDS,
  modelId: string,
  fullPrompt: string,
): Promise<string> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coverify-cli-"));
  const outFile = path.join(cwd, "last-message.txt");
  const backend = CLI_BACKENDS[provider];
  const parts = cliBackendCommand(provider)
    .replaceAll("{model}", modelId)
    .replaceAll("{out}", outFile)
    .split(/\s+/);
  return new Promise((resolve, reject) => {
    const child = spawn(parts[0], parts.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (backend.output === "oracle-json") {
        try {
          const payload = JSON.parse(out) as { ok?: boolean; text?: string; error?: string };
          if (code !== 0 || !payload.ok || !payload.text?.trim()) {
            return reject(new Error(`${provider} failed: ${payload.error ?? `exit ${code}`}`));
          }
          return resolve(payload.text.trim());
        } catch {
          return reject(new Error(`${provider} returned non-JSON output (exit ${code}): ${err.slice(0, 300)}`));
        }
      }
      if (code !== 0) return reject(new Error(`${provider} exited ${code}: ${err.slice(0, 500)}`));
      if (backend.output === "outfile" && fs.existsSync(outFile)) {
        return resolve(fs.readFileSync(outFile, "utf-8").trim());
      }
      resolve(out.trim());
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

export interface RoleSession {
  ask(prompt: string): Promise<string>;
  /** Rough context size in tokens (chars/4 over the message history). */
  approxTokens(): number;
  /** Inject a steering message while the session is running. */
  steer(text: string): void;
  /** Abort the session's current run. */
  abort(): void;
}

/**
 * A persistent role session: the same Agent instance across multiple asks,
 * accumulating context like a live harness session does. Used for the
 * coordinator, which stays resident until its context cap — the analog of
 * running the skill in Codex/Claude Code until compaction. Single-shot roles
 * (workers, critics, verifiers) go through runRole and never reuse a session.
 */
export function createRoleSession(run: Omit<RoleRun, "prompt"> & { prompt?: string }): RoleSession {
  if (isCliProvider(run.spec.provider)) {
    throw new Error("CLI backends support single-shot verdict roles only, not sessions");
  }
  const tools = run.bash ? [bashTool(run.bash.cwd, run.bash.scope)] : [];
  if (run.extraTools) tools.push(...run.extraTools);
  const agent = new Agent({
    initialState: {
      systemPrompt: systemText(run),
      model: getModel(run.models, run.spec),
      thinkingLevel: run.spec.thinking,
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
    steer(text: string): void {
      agent.steer({ role: "user", content: text, timestamp: Date.now() });
    },
    abort(): void {
      agent.abort();
    },
  };
}

/** Role charges. Each states only the role's scope; policy comes from the contract above it. */
export const CHARGES = {
  coordinator: `You are the resident coordinator of an ongoing proof-search campaign; this session
persists across wakes until its context cap. Per the contract's delegation rule: delegate
essentially all route exploration, proof or counterexample construction, computations, audits,
reconstructions, and evidence drafting to minimal-context subagents; you retain exact-statement
control, prior-route registration, assignments, promotion and ledger decisions, user updates, and
final synthesis. Doing proof work inline pollutes this long-lived context — dispatch a packet
instead. You are the sole ledger writer. Tools beyond bash: dispatch_worker, dispatch_gate_critic,
request_verification, record_promotion (the only way to append to PROVED.md), cancel_worker and
steer_worker (contract triggers only — observable struggle, user pause/stop, safety, explicit
deadline), and declare_campaign_state (pause/complete). Your bash working directory is the campaign directory;
edit the ledgers per the contract. STATEMENT.md, PROVED.md, and the harness journal are
write-protected. End every wake with your decisions recorded in the ledgers and
CURRENT_FRONTIER.md consistent with them.`,
  worker: `You are one exploration worker. You receive one packet with one finite mathematical
deliverable. Work only that packet. You may use bash in your assigned evidence directory; scratch
work may be edited freely, but never edit a file you have already cited or reported — semantic
changes to citable artifacts get a new revision-suffixed filename. Return a conclusion-first
report: the deliverable — a proved lemma, explicit construction, counterexample/certificate — or
the precise failing implication with evidence. Status reports and vague optimism are not
deliverables. Your packet may cite evidence paths and ledger locations; read them via bash when
your task needs depth — the packet is curated context, not the limit of what you may consult.`,
  gateCritic: `You are a fresh idea-gate critic. You receive only the frozen target, promoted
premises, one proposed mechanism, and its claimed first nontrivial implication. Your VERY FIRST
line must be exactly one of: IDEA PASS / IDEA FAIL / IDEA REPAIR. Then give the justification the
contract requires for that verdict.`,
  hostileAuditor: `You are stage 1 of the verification cadence: a fresh hostile auditor. You receive
the exact candidate revision, its statement, declared dependencies, and the current PROVED.md so
you can check what is actually promoted. Refute the candidate. Your VERY FIRST line must be exactly
VERDICT: PASS or VERDICT: FAIL; then the smallest concrete gap (on FAIL) or what you checked.`,
  bundleCertifier: `You certify a reconstruction bundle before blind reconstruction begins. You
receive the candidate and the proposed bundle (key ideas + allowed sources). Certify that no bundle
element amounts to a stepwise paraphrase of the candidate argument or contains it. A too-thin
bundle is safe and passes; a leaky one fails. Your VERY FIRST line must be exactly
VERDICT: PASS or VERDICT: FAIL; then the specific leaky element (on FAIL).`,
  reconstructor: `You are stage 2a of the verification cadence: a fresh no-context reconstructor.
You receive only the statement, high-level key ideas, allowed sources, and promoted premises — not
the candidate proof. Produce an end-to-end reconstruction using only that bundle. Do not give a
verdict; output the reconstruction itself, complete enough to be compared against the candidate.`,
  comparator: `You are stage 2b of the verification cadence: a fresh comparator. You receive an
independent reconstruction and the candidate's statement, conclusions, and declared dependencies.
Map the reconstruction to every conclusion and declared dependency of the candidate. Sameness of
argument is NOT required: a reconstruction establishing every conclusion by a different valid
route, within the declared dependencies and the reconstruction bundle, is a PASS — independence is
the point. A concrete mismatch is: a conclusion not established (including established only in a
weaker or nearby form), or reliance on material outside the declared dependencies and bundle. Use
the frozen statement and the candidate's declared contract; do not invent a stronger output
requirement and fail the candidate for omitting it. Your VERY FIRST line must be exactly
VERDICT: PASS or VERDICT: FAIL; then the mapping (on PASS) or the concrete mismatch (on FAIL).`,
} as const;
