import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
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
  | "reasoner"
  | "technician"
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
  "reasoner",
  "technician",
  "gateCritic",
  "hostileAuditor",
  "bundleCertifier",
  "reconstructor",
  "comparator",
];

const ROLE_ENV: Record<RoleName, string> = {
  coordinator: "COVERIFY_MODEL_COORDINATOR",
  reasoner: "COVERIFY_MODEL_REASONER",
  technician: "COVERIFY_MODEL_TECHNICIAN",
  gateCritic: "COVERIFY_MODEL_CRITIC",
  hostileAuditor: "COVERIFY_MODEL_AUDITOR",
  bundleCertifier: "COVERIFY_MODEL_CERTIFIER",
  reconstructor: "COVERIFY_MODEL_RECONSTRUCTOR",
  comparator: "COVERIFY_MODEL_COMPARATOR",
};

/** Subscription-only defaults (user decisions, 2026-08-01): OpenAI for
 *  almost everything — the coordinator's tool loop and the dispatched agents run
 *  GPT-5.6 Sol as full pi agents through the openai-codex provider
 *  (ChatGPT-subscription OAuth via `coverify login openai-codex`; @max is
 *  the top of Sol's thinking-level map), and the single-shot verdict roles
 *  run through the `codex` CLI. The one exception is the hostile auditor
 *  (the independent audit): it stays on Opus via `claude -p`, so every
 *  candidate still gets one cross-family check. Third-party OAuth against
 *  Anthropic draws Extra Credits, hence the official Claude CLI. Every
 *  role is overridable per-role or globally. */
const ROLE_DEFAULTS: Partial<Record<RoleName, string>> = {
  coordinator: "openai-codex/gpt-5.6-sol@max",
  reasoner: "openai-codex/gpt-5.6-sol@max",
  technician: "openai-codex/gpt-5.6-sol@max",
  gateCritic: "codex-cli/gpt-5.6-sol",
  hostileAuditor: "claude-cli/opus",
  bundleCertifier: "codex-cli/gpt-5.6-sol",
  reconstructor: "codex-cli/gpt-5.6-sol",
  comparator: "codex-cli/gpt-5.6-sol",
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
  /** Subtrees this role's write/run tools may write. Reads are unrestricted. */
  allow: string[];
  /** Subtrees/files denied even inside an allowed subtree (deny wins). */
  deny: string[];
}

function sbplLiteral(p: string): string {
  return `"${fs.realpathSync.native(p).replace(/"/g, '\\"')}"`;
}

/**
 * Wrap an argv in an OS write-sandbox (macOS sandbox-exec; SBPL rules are
 * last-match-wins, so denies are declared after allows). Reads stay
 * unrestricted — this narrows the tool surface, it adds no policy. On
 * non-darwin platforms the argv runs unsandboxed and callers must treat
 * write confinement as instructed-only.
 */
function sandboxedArgv(argv: string[], scope: WriteScope): { file: string; args: string[] } {
  if (process.platform !== "darwin") {
    return { file: argv[0], args: argv.slice(1) };
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
  return { file: "sandbox-exec", args: ["-p", profile, ...argv] };
}

/** Resolve to a real path even for not-yet-existing files (symlinked ancestors count). */
function realResolve(p: string): string {
  const abs = path.resolve(p);
  let dir = path.dirname(abs);
  const tail: string[] = [path.basename(abs)];
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) {
    tail.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return path.join(fs.existsSync(dir) ? fs.realpathSync.native(dir) : dir, ...tail);
}

/** In-process mirror of the OS write sandbox, for the write tool. Deny wins. */
function assertInScope(scope: WriteScope, target: string): void {
  const real = realResolve(target);
  const inside = (root: string) => {
    const r = realResolve(root);
    return real === r || real.startsWith(r + path.sep);
  };
  if (!scope.allow.some(inside) || scope.deny.some(inside)) {
    throw new Error(`write outside assigned scope: ${target}`);
  }
}

const RUN_MEM_MB = Number(process.env.COVERIFY_RUN_MEM_MB ?? 4096);

/**
 * The only way a role executes code. Enforces the launcher's "Never run
 * unsupervised detached compute.": argv only (no shell, so detach primitives
 * are not expressible), process-group kill on exit/timeout, and an RSS
 * watchdog so a runaway search is killed before it exhausts the host —
 * detached setsid-nohup search jobs memory-exhausted saturn into a kernel
 * panic on 2026-08-01.
 */
function runScriptTool(cwd: string, scope: WriteScope): AgentTool {
  return {
    name: "run_script",
    label: "Run scripts",
    description:
      `Run 1-8 script files concurrently, supervised, under ONE shared cap. Working directory: ${cwd}. ` +
      "A .py file runs under python3; anything else must be executable. Write scripts with the " +
      `write tool first. Limits for the whole batch: ${Math.round(BASH_TIMEOUT_MS / 60000)} minutes, ` +
      `${RUN_MEM_MB} MB combined RSS; writes are OS-sandboxed to your assigned directories; when the ` +
      "batch ends (or hits a limit) every process group is killed — nothing survives the call. " +
      "Route genuinely long computation through the scheduler front door instead.",
    parameters: Type.Object({
      runs: Type.Array(
        Type.Object({
          path: Type.String({ description: "Script file to run" }),
          args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script" })),
        }),
        { minItems: 1, maxItems: 8, description: "Scripts to run concurrently under the shared cap" },
      ),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const { runs } = params as { runs: { path: string; args?: string[] }[] };
      const jobs: { label: string; argv: string[] }[] = [];
      for (const r of runs) {
        const script = path.resolve(cwd, r.path);
        const label = [r.path, ...(r.args ?? [])].join(" ");
        if (!fs.existsSync(script)) return toolText(`[error: no such script: ${script}]`);
        if (script.endsWith(".py")) jobs.push({ label, argv: ["python3", script, ...(r.args ?? [])] });
        else {
          try {
            fs.accessSync(script, fs.constants.X_OK);
            jobs.push({ label, argv: [script, ...(r.args ?? [])] });
          } catch {
            return toolText(`[error: ${r.path}: script must be .py or an executable file]`);
          }
        }
      }
      // Each job leads its own process group (detached) so everything it
      // forks is reaped with it; the caps apply to the batch as a whole.
      const children = jobs.map(({ argv }) => {
        const { file, args } = sandboxedArgv(argv, scope);
        return spawn(file, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      });
      const outs = jobs.map(() => ({ stdout: "", stderr: "" }));
      children.forEach((child, i) => {
        child.stdout.on("data", (d: Buffer) => {
          if (outs[i].stdout.length <= OUTPUT_LIMIT) outs[i].stdout += d;
        });
        child.stderr.on("data", (d: Buffer) => {
          if (outs[i].stderr.length <= OUTPUT_LIMIT) outs[i].stderr += d;
        });
      });
      const killAll = () => {
        for (const child of children) {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* group already gone */
            }
          }
        }
      };
      let fate: string | undefined;
      const timer = setTimeout(() => {
        fate = `batch timed out after ${Math.round(BASH_TIMEOUT_MS / 60000)} minutes`;
        killAll();
      }, BASH_TIMEOUT_MS);
      const pgids = new Set(children.map((c) => c.pid).filter((p) => p !== undefined));
      const memWatch = setInterval(() => {
        execFile("ps", ["-axo", "pgid=,rss="], (err: Error | null, out: string) => {
          if (err || fate) return;
          let rssKb = 0;
          for (const line of out.split("\n")) {
            const [pgid, rss] = line.trim().split(/\s+/);
            if (pgids.has(Number(pgid))) rssKb += Number(rss) || 0;
          }
          if (rssKb > RUN_MEM_MB * 1024) {
            fate = `batch exceeded the ${RUN_MEM_MB} MB combined memory cap (rss ${Math.round(rssKb / 1024)} MB)`;
            killAll();
          }
        });
      }, 1000);
      // "exit" (not "close"): a forked child holding the stdio pipes must
      // not delay the group kill that reaps it.
      const codes = await Promise.all(
        children.map(
          (child) =>
            new Promise<string>((res) => {
              child.once("exit", (code, signal) => {
                if (child.pid !== undefined) {
                  try {
                    process.kill(-child.pid, "SIGKILL");
                  } catch {
                    /* group already gone */
                  }
                }
                res(code === 0 ? "" : `exit ${code ?? `signal ${signal}`}`);
              });
              child.once("error", (error: Error) => res(error.message));
            }),
        ),
      );
      clearTimeout(timer);
      clearInterval(memWatch);
      killAll();
      const sections = jobs.map(({ label }, i) => {
        let out = [outs[i].stdout, outs[i].stderr].filter(Boolean).join("\n--- stderr ---\n");
        if (out.length > OUTPUT_LIMIT) out = out.slice(0, OUTPUT_LIMIT) + "\n[truncated]";
        if (codes[i]) out = `${out}\n[error: ${codes[i]}]`;
        return jobs.length === 1 ? out : `## ${label}\n${out || "(no output)"}`;
      });
      let combined = sections.join("\n\n");
      if (fate) combined = `${combined}\n[error: ${fate}; all process groups killed]`;
      return toolText(combined || "(no output)");
    },
  } as AgentTool;
}

/** Without a code grant, roles write prose artifacts only. */
const PROSE_EXTS = new Set([".md", ".txt"]);

/** Launcher: FAILED.md and PROVED.md are append-only. PROVED.md is already
 *  write-denied by scope (record_promotion is its sole writer); FAILED.md
 *  rewrites must preserve existing entries as an unchanged prefix. */
const APPEND_ONLY_LEDGERS = new Set(["FAILED.md"]);

/**
 * Librarian command: an external subscription CLI agent that does the web
 * search and returns a compiled report, so no campaign role ever touches the
 * network itself. Space-split argv; the librarian prompt is appended as the
 * final argument.
 */
const LITERATURE_CMD = (
  process.env.COVERIFY_LITERATURE_CMD ??
  "agy --dangerously-skip-permissions --print-timeout 10m -p"
).split(/\s+/);

const LIBRARIAN_CHARGE =
  "You are a mathematical literature librarian. Web-search the question below and compile a " +
  "report: for every claim give the exact bibliographic citation (authors, title, venue, year) " +
  "and source URL; quote load-bearing statements verbatim and mark them as quotes, keeping " +
  "paraphrase clearly separate; state plainly what you could not find or verify. Never invent a " +
  "reference. The requester cannot browse; your report is their only window.\n\nQuestion:\n";

/**
 * Delegated literature search: spawns the librarian CLI supervised (own
 * process group, killed on exit/timeout) and archives the full report as an
 * evidence artifact so citations remain auditable.
 */
function literatureSearchTool(cwd: string): AgentTool {
  return {
    name: "literature_search",
    label: "Literature search",
    description:
      "Ask an external librarian agent (with live web search) one literature question. Returns a " +
      "compiled report with citations and URLs, archived verbatim under your evidence directory " +
      "as literature-<n>.md. The librarian's claims are secondhand: treat them as leads, cite the " +
      "archived report, and label dependencies per the contract. One question per call; " +
      `${Math.round(BASH_TIMEOUT_MS / 60000)}-minute limit.`,
    parameters: Type.Object({
      question: Type.String({ description: "The literature question, self-contained" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) =>
      new Promise((resolve) => {
        const { question } = params as { question: string };
        const child = spawn(LITERATURE_CMD[0], [...LITERATURE_CMD.slice(1), LIBRARIAN_CHARGE + question], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => {
          if (stdout.length <= OUTPUT_LIMIT * 4) stdout += d;
        });
        child.stderr.on("data", (d: Buffer) => {
          if (stderr.length <= OUTPUT_LIMIT) stderr += d;
        });
        const killGroup = () => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* group already gone */
            }
          }
        };
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, BASH_TIMEOUT_MS);
        child.once("exit", (code) => {
          clearTimeout(timer);
          killGroup();
          if (timedOut || code !== 0 || !stdout.trim()) {
            const detail = timedOut ? "timed out" : `exit ${code}`;
            return resolve(toolText(`[error: librarian ${detail}]${stderr ? `\n${stderr.slice(0, 2000)}` : ""}`));
          }
          const n = fs.readdirSync(cwd).filter((f) => /^literature-\d+\.md$/.test(f)).length + 1;
          const artifact = path.join(cwd, `literature-${n}.md`);
          fs.writeFileSync(
            artifact,
            `# Literature search ${n}\n\nLibrarian: \`${LITERATURE_CMD.join(" ")}\` (self-attested provenance)\n\n## Question\n\n${question}\n\n## Report\n\n${stdout}\n`,
          );
          let out = stdout;
          if (out.length > OUTPUT_LIMIT) out = out.slice(0, OUTPUT_LIMIT) + "\n[truncated; full report in artifact]";
          resolve(toolText(`[archived: ${artifact}]\n\n${out}`));
        });
        child.once("error", (error: Error) => {
          clearTimeout(timer);
          killGroup();
          resolve(toolText(`[error: ${error.message}]`));
        });
      }),
  } as AgentTool;
}

/**
 * The role tool surface for a workspace: pi's read-only file tools
 * (read, ls, grep) and pi's write tool wrapped with the role's write scope.
 * No general shell. Code is gated: only a role whose dispatch packet carried
 * a computation declaration (launcher: "preregistered finite domain and
 * stopping rule") gets run_script and the right to write non-prose files.
 */
export function workspaceTools(
  cwd: string,
  scope: WriteScope,
  opts?: { code?: boolean; literature?: boolean },
): AgentTool[] {
  const code = opts?.code === true;
  const scopedWrite = createWriteTool(cwd, {
    operations: {
      writeFile: async (absolutePath: string, content: string) => {
        assertInScope(scope, absolutePath);
        if (!code && !PROSE_EXTS.has(path.extname(absolutePath).toLowerCase())) {
          throw new Error(
            "this role writes prose artifacts only (.md/.txt); code runs only in a technician " +
              "dispatch (launcher preregistration)",
          );
        }
        const base = path.basename(absolutePath);
        if (APPEND_ONLY_LEDGERS.has(base) && fs.existsSync(absolutePath)) {
          const prior = await fs.promises.readFile(absolutePath, "utf8");
          if (!content.startsWith(prior) && !content.startsWith(prior.trimEnd())) {
            throw new Error(
              `${base} is append-only (launcher): new content must begin with the existing ` +
                "content unchanged; append below it",
            );
          }
        }
        if (/^literature-\d+\.md$/.test(base) && fs.existsSync(absolutePath)) {
          throw new Error("librarian reports are immutable evidence; write a new file instead");
        }
        await fs.promises.writeFile(absolutePath, content);
      },
      mkdir: async (dir: string) => {
        assertInScope(scope, dir);
        await fs.promises.mkdir(dir, { recursive: true });
      },
    },
  });
  const tools = [createReadTool(cwd), createLsTool(cwd), createGrepTool(cwd), scopedWrite] as AgentTool[];
  if (code) tools.push(runScriptTool(cwd, scope));
  if (opts?.literature === true) tools.push(literatureSearchTool(cwd));
  return tools;
}

export interface RoleRun {
  /** The full launcher contract text (verbatim), embedded in the system prompt. */
  contract: string;
  /** One-paragraph role charge appended after the contract. */
  charge: string;
  prompt: string;
  /** Give the role the workspace tools (read/ls/grep, scoped write; run_script iff code;
   *  librarian search iff literature). */
  workspace?: { cwd: string; scope: WriteScope; code?: boolean; literature?: boolean };
  extraTools?: AgentTool[];
  spec: ModelSpec;
  models: Models;
}

/**
 * Run one fresh, ephemeral role instance (single-shot roles: idea-gate
 * critic, hostile auditor, bundle certifier, reconstructor, comparator).
 * The coordinator and dispatched agents use createRoleSession directly. What each
 * instance sees is decided by the bundle its caller builds; the journal
 * records supplied inputs and which restrictions are platform-enforced
 * versus instructed.
 */
export async function runRole(run: RoleRun): Promise<RoleResult> {
  if (isCliProvider(run.spec.provider)) {
    if (run.workspace || run.extraTools) {
      throw new Error("CLI backends support single-shot verdict roles only (no tools)");
    }
    const text = await runCliRole(run.spec.provider, run.spec.modelId, `${systemText(run)}\n\n---\n\n${run.prompt}`);
    return { text };
  }
  const session = createRoleSession(run);
  const text = await session.ask(run.prompt);
  return { text, usage: session.usage() };
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
  /** Cumulative provider-reported token usage across the session's calls. */
  usage(): RoleUsage;
  /** Inject a steering message while the session is running. */
  steer(text: string): void;
  /** Abort the session's current run. */
  abort(): void;
}

/** Provider-reported token usage (pi-ai Usage, summed). CLI backends report
 *  none — mechanics only; nothing reads this except the journal. */
export interface RoleUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

function agentUsage(agent: Agent): RoleUsage {
  const total: RoleUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of agent.state.messages) {
    const u = (m as { role?: string; usage?: RoleUsage }).usage;
    if ((m as { role?: string }).role !== "assistant" || !u) continue;
    total.input += u.input ?? 0;
    total.output += u.output ?? 0;
    total.cacheRead += u.cacheRead ?? 0;
    total.cacheWrite += u.cacheWrite ?? 0;
    if (u.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + u.reasoning;
  }
  return total;
}

export interface RoleResult {
  text: string;
  /** Undefined for CLI backends (no usage reporting). */
  usage?: RoleUsage;
}

/**
 * A persistent role session: the same Agent instance across multiple asks,
 * accumulating context like a live harness session does. Used for the
 * coordinator, which stays resident until its context cap — the analog of
 * running the skill in Codex/Claude Code until compaction. Single-shot roles
 * (reasoners, technicians, critics, verifiers) go through runRole and never reuse a session.
 */
export function createRoleSession(run: Omit<RoleRun, "prompt"> & { prompt?: string }): RoleSession {
  if (isCliProvider(run.spec.provider)) {
    throw new Error("CLI backends support single-shot verdict roles only, not sessions");
  }
  const tools = run.workspace
    ? workspaceTools(run.workspace.cwd, run.workspace.scope, {
        code: run.workspace.code,
        literature: run.workspace.literature,
      })
    : [];
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
    usage(): RoleUsage {
      return agentUsage(agent);
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
instead. You are the sole ledger writer. Your workspace tools (read, ls, grep, write) handle prose
artifacts only — you cannot write or run code and cannot search the web; a computation belongs in
a dispatch_technician packet (its computation field states the preregistered finite domain and
stopping rule), and a literature question belongs in a dispatch_reasoner packet whose literature
field states it, which grants that reasoner a delegated librarian search tool (reasoners never
hold code tools). Tools beyond the workspace tools: dispatch_reasoner, dispatch_technician, dispatch_gate_critic,
request_verification, record_promotion (the only way to append to PROVED.md), cancel_agent and
steer_agent (contract triggers only — observable struggle, user pause/stop, safety, explicit
deadline), and declare_campaign_state (pause/complete). Your workspace tools work in the campaign directory;
edit the ledgers per the contract. STATEMENT.md, PROVED.md, and the harness journal are
write-protected. End every wake with your decisions recorded in the ledgers and
CURRENT_FRONTIER.md consistent with them.`,
  reasoner: `You are one exploration reasoner. You receive one packet with one finite mathematical
deliverable. Work only that packet. You have workspace tools (read, ls, grep, write) in your
assigned evidence directory; you cannot write or run code — computation happens in a separate
technician dispatch. If your packet carries a literature
question you also have literature_search (a delegated librarian with web access — archive and
cite its reports, and treat its claims as leads, not established results); scratch
work may be edited freely, but never edit a file you have already cited or reported — semantic
changes to citable artifacts get a new revision-suffixed filename. Return a conclusion-first
report: the deliverable — a proved lemma, explicit construction, counterexample/certificate — or
the precise failing implication with evidence. Status reports and vague optimism are not
deliverables. Your packet may cite evidence paths and ledger locations; read them with your
read/grep tools when
your task needs depth — the packet is curated context, not the limit of what you may consult.`,
  technician: `You are one computation technician. You receive one packet with one preregistered
computation: a finite domain, stopping rule, and expected witness, certificate, or table. Your
mathematics is confined to faithfully encoding the stated definitions and domain into code — you
advance no proofs, choose no routes, and do not interpret results beyond what was computed. Write
your scripts with the write tool and run them with run_script; iterate only to fix faithfulness,
bugs, or performance within the declared domain and limits, never to extend the search beyond the
preregistration — a domain you believe should be larger is a report, not a decision. Return a
conclusion-first report: the raw outputs (saved as evidence artifacts), exactly what was computed
and how the encoding maps to the stated definitions, and implementation caveats. Never edit a
file you have already cited or reported.`,
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
