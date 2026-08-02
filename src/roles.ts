import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  Agent,
  AgentHarness,
  JsonlSessionRepo,
  estimateContextTokens,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
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
import { CLAUDE_BRIDGE_ID, claudeBridgeProvider } from "./claude-bridge.js";
import { Type } from "typebox";

const OUTPUT_LIMIT = 50_000;
/**
 * Live batch reapers. Every supervised batch registers one so that a harness
 * that dies — operator Ctrl-C on a machine being eaten, a crash, an OOM kill —
 * takes its compute with it. Without this the scripts are detached process
 * groups with no watchdog left: exactly the uncapped runaway this layer
 * exists to prevent.
 */
const liveReapers = new Set<() => void>();
let reaperHooksInstalled = false;
function installReaperHooks(): void {
  if (reaperHooksInstalled) return;
  reaperHooksInstalled = true;
  const reapAll = () => {
    for (const reap of [...liveReapers]) {
      try {
        reap();
      } catch {
        /* best effort on the way out */
      }
    }
  };
  process.on("exit", reapAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      reapAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/** A malformed limit must not silently become NaN: setTimeout(fn, NaN) fires
 *  immediately, which would time out every batch instantly. */
function positiveEnvNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Wall limit for one run_script batch / one librarian call. Never a
 *  proof-work timebox (the launcher forbids those) — supervision only. */
export const RUN_TIMEOUT_MS = positiveEnvNumber(process.env.COVERIFY_RUN_TIMEOUT_MS, 600_000);

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
    | typeof CLAUDE_BRIDGE_ID
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
 *  role is overridable per-role via COVERIFY_MODEL_<ROLE>. */
const ROLE_DEFAULTS: Record<RoleName, string> = {
  coordinator: "openai-codex/gpt-5.6-sol@max",
  reasoner: "openai-codex/gpt-5.6-sol@max",
  technician: "openai-codex/gpt-5.6-sol@max",
  gateCritic: "codex-cli/gpt-5.6-sol",
  hostileAuditor: "claude-cli/opus",
  bundleCertifier: "codex-cli/gpt-5.6-sol",
  reconstructor: "codex-cli/gpt-5.6-sol",
  comparator: "codex-cli/gpt-5.6-sol",
};

/** Spec format: `provider/model[@thinking]`; bare model id means anthropic. */
function parseModelSpec(spec: string): ModelSpec {
  const [modelPart, thinking = "high"] = spec.split("@");
  const slash = modelPart.indexOf("/");
  const provider = slash < 0 ? "anthropic" : modelPart.slice(0, slash);
  const modelId = slash < 0 ? modelPart : modelPart.slice(slash + 1);
  if (
    provider !== "anthropic" &&
    provider !== "openai" &&
    provider !== "openai-codex" &&
    provider !== "google" &&
    provider !== CLAUDE_BRIDGE_ID &&
    provider !== "claude-cli" &&
    provider !== "codex-cli" &&
    provider !== "chatgpt-cli"
  ) {
    throw new Error(`unknown provider "${provider}" in model spec "${spec}"`);
  }
  return { provider, modelId, thinking: thinking as ThinkingLevel };
}

/** Resolution: COVERIFY_MODEL_<ROLE> > role default (every role has one). */
export function roleModelSpec(role: RoleName): ModelSpec {
  return parseModelSpec(process.env[ROLE_ENV[role]] ?? ROLE_DEFAULTS[role]);
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
 * non-darwin platforms the backend is @landstrip/landstrip (Landlock +
 * seccomp on Linux — kernel-enforced, no root; ecosystem adoption
 * 2026-08-02): same WriteScope semantics plus deny-default networking.
 * If the landstrip binary is unavailable there, the argv runs unsandboxed
 * and write confinement degrades to instructed-only — loudly.
 */
const LANDSTRIP_BIN = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "node_modules",
  ".bin",
  "landstrip",
);
let landstripChecked = false;
let landstripUsable = false;
function landstripAvailable(): boolean {
  if (!landstripChecked) {
    landstripChecked = true;
    landstripUsable = fs.existsSync(LANDSTRIP_BIN);
    if (!landstripUsable) {
      console.error(
        "[coverify] landstrip binary not found — non-darwin write confinement is " +
          "INSTRUCTED-ONLY for this run (bun install to restore the sandbox)",
      );
    }
  }
  return landstripUsable;
}

/** WriteScope → landstrip policy JSON. Reads stay unrestricted (fields
 *  omitted); network deny-default is landstrip's default, stated explicitly.
 *  Deny targets need no existence dance here: landstrip evaluates globs at
 *  access time, covering the not-yet-existing forged-PROVED.md case. */
function landstripPolicy(scope: WriteScope): object {
  // Canonical paths only: landstrip refuses deny targets reachable through a
  // symlinked ancestor of an allow root (POLICY_DENY_WRITE_SYMLINK_ANCESTOR),
  // e.g. /tmp → /private/tmp. realResolve also canonicalizes not-yet-existing
  // deny targets against their deepest real ancestor.
  const canon = (p: string) => realResolve(p);
  return {
    enabled: true,
    network: { allowNetwork: false, allowLocalBinding: false, allowAllUnixSockets: false },
    filesystem: {
      allowWrite: [...new Set([...scope.allow.map(canon), canon(os.tmpdir()), "/dev/null"])],
      denyWrite: scope.deny.map(canon),
    },
  };
}

function sandboxedArgv(argv: string[], scope: WriteScope): { file: string; args: string[] } {
  if (process.platform !== "darwin") {
    if (!landstripAvailable()) {
      return { file: argv[0], args: argv.slice(1) };
    }
    const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), "coverify-policy-"));
    const policyFile = path.join(policyDir, "policy.json");
    fs.writeFileSync(policyFile, JSON.stringify(landstripPolicy(scope)));
    return { file: LANDSTRIP_BIN, args: ["run", "-p", policyFile, "--", ...argv] };
  }
  const allows = [
    '(subpath "/private/tmp")',
    '(subpath "/private/var/folders")',
    '(literal "/dev/null")',
    ...scope.allow.filter((p) => fs.existsSync(p)).map((p) => `(subpath ${sbplLiteral(p)})`),
  ].join(" ");
  // A deny target that does not exist yet must still be denied, or a script
  // could *create* it (a forged PROVED.md). sbplLiteral needs a real path, so
  // resolve the parent and re-attach the name.
  const denyEntries = scope.deny
    .map((p) => {
      if (fs.existsSync(p)) return `(subpath ${sbplLiteral(p)}) (literal ${sbplLiteral(p)})`;
      const parent = path.dirname(p);
      if (!fs.existsSync(parent)) return "";
      const target = JSON.stringify(path.join(fs.realpathSync.native(parent), path.basename(p)));
      return `(subpath ${target}) (literal ${target})`;
    })
    .filter(Boolean)
    .join(" ");
  const profile =
    `(version 1) (allow default) (deny file-write* (subpath "/")) (allow file-write* ${allows})` +
    (denyEntries ? ` (deny file-write* ${denyEntries})` : "");
  return { file: "sandbox-exec", args: ["-p", profile, ...argv] };
}

/** Fully resolve a path, including the final component when it exists — a
 *  symlink the role created inside its own directory must be judged by its
 *  target, or scope checks are decorative. Components that do not exist yet
 *  are appended to the deepest resolved ancestor. */
function realResolve(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    try {
      return fs.realpathSync.native(abs);
    } catch {
      /* raced away; fall through to the ancestor walk */
    }
  }
  let dir = path.dirname(abs);
  const tail: string[] = [path.basename(abs)];
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) {
    tail.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return path.join(fs.existsSync(dir) ? fs.realpathSync.native(dir) : dir, ...tail);
}

/**
 * In-process mirror of the OS write sandbox. Deny wins.
 *
 * Allow is compared exactly: on a case-insensitive volume `realResolve`
 * already returns the canonical on-disk case for anything that exists, and on
 * a case-sensitive volume `t001` and `T001` are genuinely different
 * directories that must not be conflated. Deny is compared case-folded as
 * well, because a *not-yet-existing* `proved.md` resolves to that spelling
 * while naming the same file as `PROVED.md` on a case-insensitive volume.
 */
function inScope(scope: WriteScope, target: string): boolean {
  const real = realResolve(target);
  const under = (child: string, root: string) => child === root || child.startsWith(root + path.sep);
  const allowed = scope.allow.some((root) => under(real, realResolve(root)));
  const denied = scope.deny.some((root) => {
    const r = realResolve(root);
    return under(real, r) || under(real.toLowerCase(), r.toLowerCase());
  });
  return allowed && !denied;
}

function assertInScope(scope: WriteScope, target: string): void {
  if (!inScope(scope, target)) throw new Error(`write outside assigned scope: ${target}`);
}

export const RUN_MEM_MB = positiveEnvNumber(process.env.COVERIFY_RUN_MEM_MB, 4096);

/**
 * One `ps` sweep: every process that belongs to this batch — descended from
 * `roots` by parent chain, sharing one of their process groups, or still
 * running one of the batch's script paths on its command line. The last test
 * is what catches a child that called setpgrp() and was then reparented to
 * pid 1, where neither group nor parent chain can reach it.
 */
interface Proc {
  ppid: number;
  pgid: number;
  rssKb: number;
  args: string;
}

function processSweep(
  roots: ReadonlySet<number>,
  marks: readonly string[],
): Promise<{ members: Map<number, Proc>; rssKb: number }> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid=,pgid=,rss=,args="], { maxBuffer: 64 * 1024 * 1024 }, (err: Error | null, out: string) => {
      if (err) return reject(err);
      const rows = new Map<number, Proc>();
      for (const line of out.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        if (m)
          rows.set(Number(m[1]), {
            ppid: Number(m[2]),
            pgid: Number(m[3]),
            rssKb: Number(m[4]),
            args: m[5],
          });
      }
      if (rows.size === 0) return reject(new Error("ps returned no parseable rows"));
      const members = new Map<number, Proc>();
      for (const [pid, r] of rows) {
        if (pid === process.pid) continue;
        if (roots.has(pid) || roots.has(r.pgid) || marks.some((m) => r.args.includes(m))) {
          members.set(pid, r);
        }
      }
      for (let changed = true; changed; ) {
        changed = false;
        for (const [pid, r] of rows) {
          if (pid !== process.pid && !members.has(pid) && members.has(r.ppid)) {
            members.set(pid, r);
            changed = true;
          }
        }
      }
      let rssKb = 0;
      for (const r of members.values()) rssKb += r.rssKb;
      resolve({ members, rssKb });
    });
  });
}

/**
 * The only way a role executes code. Enforces the launcher's "Never run
 * unsupervised detached compute.": argv only and confined to the role's own
 * directory (no shell, no host interpreter, so detach primitives are not
 * expressible), whole-process-tree kill on exit/timeout, and an RSS watchdog
 * so a runaway search is killed before it exhausts the host — detached
 * setsid-nohup search jobs memory-exhausted saturn into a kernel panic on
 * 2026-08-01.
 */
export function runScriptTool(cwd: string, scope: WriteScope): AgentTool {
  return {
    name: "run_script",
    label: "Run scripts",
    description:
      `Run 1-8 script files concurrently, supervised, under ONE shared cap. Working directory: ${cwd}. ` +
      "Each script must be a file inside your assigned directory: a .py runs under python3, " +
      "anything else must be executable. Write scripts with the write tool first. Limits for the " +
      `whole batch: ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes, ${RUN_MEM_MB} MB combined RSS; ` +
      "writes are OS-sandboxed to your assigned directories; when the batch ends (or hits a limit) " +
      "the whole process tree is killed — nothing survives the call. Route genuinely long " +
      "computation through the scheduler front door instead.",
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
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const { runs } = params as { runs: { path: string; args?: string[] }[] };
      const jobs: { label: string; script: string; argv: string[] }[] = [];
      for (const r of runs) {
        const script = path.resolve(cwd, r.path);
        const label = [r.path, ...(r.args ?? [])].join(" ");
        // The script must be one the role wrote in its own scope. Without
        // this, `path` could name any host executable (/bin/sh -c ..., or
        // python3 -c ...), handing back the general shell this tool removes.
        if (!inScope(scope, script)) {
          return toolText(
            `[error: ${r.path}: run_script executes only scripts inside your assigned directory; ` +
              "write the script there first]",
          );
        }
        if (!fs.existsSync(script)) return toolText(`[error: no such script: ${script}]`);
        if (script.endsWith(".py")) jobs.push({ label, script, argv: ["python3", script, ...(r.args ?? [])] });
        else {
          try {
            fs.accessSync(script, fs.constants.X_OK);
            jobs.push({ label, script, argv: [script, ...(r.args ?? [])] });
          } catch {
            return toolText(`[error: ${r.path}: script must be .py or an executable file]`);
          }
        }
      }
      // Sweep marks: the working directory plus each script path, so a
      // survivor that left the process group is still found by command line.
      const { outs, fate } = await supervise(
        jobs.map(({ argv }) => sandboxedArgv(argv, scope)),
        { cwd, marks: [cwd, ...jobs.map((j) => j.script)], signal },
      );
      const sections = jobs.map(({ label }, i) => {
        let out = [outs[i].stdout, outs[i].stderr].filter(Boolean).join("\n--- stderr ---\n");
        if (out.length > OUTPUT_LIMIT) {
          // Tee before truncating (ecosystem review 2026-08-02, from hypa's
          // pattern): the tail was the tool layer's one silently-lost data.
          // The full output lands in the role's own directory as an ordinary
          // retrievable artifact.
          let ref = "";
          try {
            const teeName = `run_script-full-${Date.now()}-${i}.log`;
            fs.writeFileSync(path.join(cwd, teeName), out);
            ref = `; full output saved to ${teeName}`;
          } catch {
            /* tee is best-effort; truncation marker stays honest either way */
          }
          out = out.slice(0, OUTPUT_LIMIT) + `\n[truncated${ref}]`;
        }
        if (outs[i].failure) out = `${out}\n[error: ${outs[i].failure}]`;
        return jobs.length === 1 ? out : `## ${label}\n${out || "(no output)"}`;
      });
      let combined = sections.join("\n\n");
      if (fate) combined = `${combined}\n[error: ${fate}; whole process tree killed]`;
      return toolText(combined || "(no output)");
    },
  } as AgentTool;
}

interface SupervisedOut {
  stdout: string;
  stderr: string;
  /** Non-empty when this process failed (non-zero exit, signal, spawn error). */
  failure: string;
}

/**
 * Run one or more argvs concurrently under a single supervision regime: shared
 * wall limit, shared RSS cap, whole-tree kill on exit/timeout/abort, and a
 * reaper so a dying harness takes the compute with it. Every path that
 * executes anything goes through here — run_script and the delegated
 * librarian alike — so neither becomes a doorway to the uncapped runaway that
 * kernel-panicked the host on 2026-08-01.
 */
async function supervise(
  specs: { file: string; args: string[] }[],
  opts: { cwd: string; marks: string[]; signal?: AbortSignal; outputLimit?: number },
): Promise<{ outs: SupervisedOut[]; fate?: string }> {
  const limit = opts.outputLimit ?? OUTPUT_LIMIT;
  const children = specs.map(({ file, args }) =>
    spawn(file, args, { cwd: opts.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
  );
  const outs: SupervisedOut[] = specs.map(() => ({ stdout: "", stderr: "", failure: "" }));
  children.forEach((child, i) => {
    child.stdout.on("data", (d: Buffer) => {
      if (outs[i].stdout.length <= limit) outs[i].stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (outs[i].stderr.length <= limit) outs[i].stderr += d;
    });
  });
  const roots = new Set(children.map((c) => c.pid).filter((p): p is number => p !== undefined));
  let fate: string | undefined;
  let finished = false;
  const killGroups = () => {
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
  const killAll = async () => {
    // Two passes: killing the parents first stops them forking more, and the
    // second sweep catches anything spawned between sweep and kill.
    for (let pass = 0; pass < 2; pass++) {
      killGroups();
      const sweep = await processSweep(roots, opts.marks).catch(() => undefined);
      for (const pid of sweep?.members.keys() ?? []) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  };
  installReaperHooks();
  liveReapers.add(killGroups);
  const timer = setTimeout(() => {
    if (finished) return;
    fate = `timed out after ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes`;
    void killAll();
  }, RUN_TIMEOUT_MS);
  const onAbort = () => {
    if (finished) return;
    fate = "cancelled";
    void killAll();
  };
  // Pre-check: an abort that landed before this call never fires the listener.
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const memWatch = setInterval(() => {
    if (fate || finished) return;
    processSweep(roots, opts.marks).then(
      ({ rssKb }) => {
        // `finished` is re-read here: a sweep in flight when the batch ended
        // must not report a completed run as killed.
        if (fate || finished) return;
        if (rssKb > RUN_MEM_MB * 1024) {
          fate = `exceeded the ${RUN_MEM_MB} MB combined memory cap (rss ${Math.round(rssKb / 1024)} MB)`;
          void killAll();
        }
      },
      (err: Error) => {
        if (fate || finished) return;
        // A silently absent cap is worse than a loud one: stop rather than
        // let an unmetered search run.
        fate = `memory watchdog unavailable (${err.message}); stopped rather than run uncapped`;
        void killAll();
      },
    );
  }, 500);
  // "exit", never "close": a survivor holding the inherited stdio pipes would
  // otherwise keep this promise pending forever, wedging the whole campaign.
  await Promise.all(
    children.map(
      (child, i) =>
        new Promise<void>((res) => {
          child.once("exit", (code, signal) => {
            if (code !== 0) outs[i].failure = `exit ${code ?? `signal ${signal}`}`;
            res();
          });
          child.once("error", (error: Error) => {
            outs[i].failure = error.message;
            res();
          });
        }),
    ),
  );
  finished = true;
  clearTimeout(timer);
  clearInterval(memWatch);
  opts.signal?.removeEventListener("abort", onAbort);
  // Awaited: survivors that left the process group are reaped here, so nothing
  // outlives the call even when the direct children exited cleanly.
  await killAll();
  liveReapers.delete(killGroups);
  return { outs, fate };
}

/** Without a code grant, roles write prose artifacts only. */
const PROSE_EXTS = new Set([".md", ".txt"]);

/** Launcher: FAILED.md and PROVED.md are append-only. PROVED.md is already
 *  write-denied by scope (record_promotion is its sole writer); FAILED.md
 *  rewrites must preserve existing entries as an unchanged prefix. */
const APPEND_ONLY_LEDGERS = new Set(["failed.md"]);

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

/**
 * State directories the librarian CLI may write (token refresh, cache).
 * Deliberately narrow: `~/.claude`, `~/.codex`, and `~/.config` hold settings
 * and hook files that execute on a later run — and coverify's own OAuth store
 * lives in `~/.config/coverify` — so a role-authored prompt must not reach
 * them. Override for a different librarian binary with
 * COVERIFY_LITERATURE_STATE_DIRS (colon-separated absolute paths).
 */
const LIBRARIAN_STATE_DIRS = (
  process.env.COVERIFY_LITERATURE_STATE_DIRS?.split(":").filter(Boolean) ??
  [".gemini", ".antigravity"].map((d) => path.join(os.homedir(), d))
).filter((d) => path.isAbsolute(d) && d !== os.homedir());

const LIBRARIAN_CHARGE =
  "You are a mathematical literature librarian. Web-search the question below and compile a " +
  "report: for every claim give the exact bibliographic citation (authors, title, venue, year) " +
  "and source URL; quote load-bearing statements verbatim and mark them as quotes, keeping " +
  "paraphrase clearly separate; state plainly what you could not find or verify. Never invent a " +
  "reference. State each imported theorem with its exact hypotheses, not just its name.\n\n" +
  "Scope limit (the requester's contract): public search is for ordinary background and standard " +
  "named theorems only. Do not search for a solution to the requester's target problem, for an " +
  "equivalent or paraphrased formulation of it, or for distinctive fragments of it. If the " +
  "question asks you to do that, refuse it, say so plainly, and answer only the background part.\n\n" +
  "The requester cannot browse; your report is their only window.\n\nQuestion:\n";

/**
 * Delegated literature search: spawns the librarian CLI supervised (own
 * process group, killed on exit/timeout) and archives the full report as an
 * evidence artifact so citations remain auditable.
 */
function literatureSearchTool(cwd: string, scope: WriteScope): AgentTool {
  return {
    name: "literature_search",
    label: "Literature search",
    description:
      "Ask an external librarian agent (with live web search) one literature question. Returns a " +
      "compiled report with citations and URLs, archived verbatim under your evidence directory " +
      "as literature-<n>.md. The librarian's claims are secondhand: treat them as leads, cite the " +
      "archived report, and label dependencies per the contract. One question per call; " +
      `${Math.round(RUN_TIMEOUT_MS / 60000)}-minute limit.`,
    parameters: Type.Object({
      question: Type.String({ description: "The literature question, self-contained" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
      const { question } = params as { question: string };
      // Sandboxed and supervised exactly like run_script — the librarian is a
      // full coding agent (its default argv skips its own permission prompts)
      // driven by a role-authored question, so it gets the same write
      // confinement, memory cap, tree kill, and reaper. Its own state
      // directories stay writable: a CLI that cannot refresh its OAuth token
      // fails as an opaque non-zero exit.
      const spec = sandboxedArgv([...LITERATURE_CMD, LIBRARIAN_CHARGE + question], {
        allow: [...scope.allow, ...LIBRARIAN_STATE_DIRS],
        deny: scope.deny,
      });
      const { outs, fate } = await supervise([spec], {
        cwd,
        marks: [cwd],
        signal,
        outputLimit: OUTPUT_LIMIT * 4,
      });
      const { stdout, stderr, failure } = outs[0];
      if (fate || failure || !stdout.trim()) {
        const detail = fate ?? failure ?? "produced no report";
        return toolText(`[error: librarian ${detail}]${stderr ? `\n${stderr.slice(0, 2000)}` : ""}`);
      }
      // The harness owns the archive name and content: a librarian report is
      // provenance, so a role must never be able to author one by hand.
      const n = fs.readdirSync(cwd).filter((f) => /^literature-\d+\.md$/i.test(f)).length + 1;
      const artifact = path.join(cwd, `literature-${n}.md`);
      fs.writeFileSync(
        artifact,
        `# Literature search ${n}\n\nLibrarian: \`${LITERATURE_CMD.join(" ")}\` (self-attested provenance)\n\n## Question\n\n${question}\n\n## Report\n\n${stdout}\n`,
      );
      let out = stdout;
      if (out.length > OUTPUT_LIMIT) out = out.slice(0, OUTPUT_LIMIT) + "\n[truncated; full report in artifact]";
      return toolText(`[archived: ${artifact}]\n\n${out}`);
    },
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
        // Every rule below judges the resolved path, never the typed one: a
        // symlink named `notes.md` must not smuggle a write into a script or
        // through to a ledger under another name.
        const real = realResolve(absolutePath);
        const base = path.basename(real).toLowerCase();
        if (!code && !PROSE_EXTS.has(path.extname(base))) {
          throw new Error(
            "this role writes prose artifacts only (.md/.txt); code runs only in a technician " +
              "dispatch (launcher preregistration)",
          );
        }
        if (APPEND_ONLY_LEDGERS.has(base) && fs.existsSync(real)) {
          const prior = await fs.promises.readFile(real, "utf8");
          if (!content.startsWith(prior) && !content.startsWith(prior.trimEnd())) {
            throw new Error(
              `${path.basename(real)} is append-only (launcher): new content must begin with the existing ` +
                "content unchanged; append below it",
            );
          }
        }
        if (/^literature-\d+\.md$/i.test(base)) {
          throw new Error(
            "literature-<n>.md names are owned by literature_search (provenance): a role may " +
              "neither author nor edit one; use a different filename",
          );
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
  if (opts?.literature === true) tools.push(literatureSearchTool(cwd, scope));
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
 * The coordinator and dispatched agents run as durable sessions via
 * createHarnessRoleSession (harness.ts). What each
 * instance sees is decided by the bundle its caller builds; the journal
 * records supplied inputs and which restrictions are platform-enforced
 * versus instructed.
 */
export async function runRole(run: RoleRun): Promise<RoleResult> {
  if (isCliProvider(run.spec.provider)) {
    if (run.workspace || run.extraTools) {
      throw new Error("CLI backends support single-shot verdict roles only (no tools)");
    }
    const fullPrompt = `${systemText(run)}\n\n---\n\n${run.prompt}`;
    const started = Date.now();
    const result = await runCliRole(run.spec.provider, run.spec.modelId, fullPrompt);
    return { ...result, promptChars: fullPrompt.length, durationMs: Date.now() - started };
  }
  const started = Date.now();
  const session = createRoleSession(run);
  const text = await session.ask(run.prompt);
  return { text, usage: session.usage(), promptChars: run.prompt.length, durationMs: Date.now() - started };
}

export function isCliProvider(p: string): p is keyof typeof CLI_BACKENDS {
  return p in CLI_BACKENDS;
}

interface CliBackend {
  env: string;
  cmd: string;
  /** Where the final text lives: stdout raw, stdout JSON, an {out} file, or the oracle's JSON. */
  output: "stdout" | "claude-json" | "outfile" | "oracle-json";
  /** Backend-specific stdout-side usage parser (telemetry only), orthogonal to `output`. */
  usage?: (stdout: string) => RoleUsage | undefined;
}

/** Subscription-billed official CLIs as verdict-role backends. Command
 *  templates are env-overridable so CLI flag drift never needs a harness
 *  release; {model} and {out} are substituted. Both official CLIs are asked
 *  for machine-readable output so per-call token usage reaches the journal
 *  (claude: result JSON on stdout; codex: JSONL events with turn usage);
 *  an env-overridden template without those flags degrades to text-only. */
const CLI_BACKENDS: Record<"claude-cli" | "codex-cli" | "chatgpt-cli", CliBackend> = {
  "claude-cli": {
    env: "COVERIFY_CLAUDE_CMD",
    cmd: "claude -p --model {model} --output-format json",
    output: "claude-json",
  },
  "codex-cli": {
    env: "COVERIFY_CODEX_CMD",
    cmd: "codex exec --json --model {model} --sandbox read-only --skip-git-repo-check --output-last-message {out} -",
    output: "outfile",
    usage: codexJsonlUsage,
  },
  /** Chao's chatgpt.com daemon CLI (gitea chaoxu/chatgpt-cli): the only road
   *  to ChatGPT-Pro-only models (gpt-5.6-pro) — the deep one-shot prover.
   *  The daemon picks the actual model; the spec's modelId is a provenance
   *  label. Emits {ok, text, error} JSON on stdout. */
  "chatgpt-cli": { env: "COVERIFY_CHATGPT_CMD", cmd: "chatgpt-cli oracle --quiet --timeout 6000", output: "oracle-json" },
};

export function cliBackendCommand(provider: keyof typeof CLI_BACKENDS): string {
  const backend = CLI_BACKENDS[provider];
  return process.env[backend.env] ?? backend.cmd;
}

function systemText(run: Pick<RoleRun, "contract" | "charge">): string {
  return `The campaign contract below governs this work. Follow it exactly.\n\n<contract>\n${run.contract}\n</contract>\n\n${run.charge}`;
}

/** claude -p --output-format json result payload (the fields we read). */
interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Sum token usage from codex --json JSONL events ({type:"turn.completed"}). */
function codexJsonlUsage(stdout: string): RoleUsage | undefined {
  let found = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  for (const line of stdout.split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    let event: {
      type?: string;
      usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "turn.completed" || !event.usage) continue;
    found = true;
    input += event.usage.input_tokens ?? 0;
    output += event.usage.output_tokens ?? 0;
    cacheRead += event.usage.cached_input_tokens ?? 0;
    cacheWrite += event.usage.cache_write_input_tokens ?? 0;
    reasoning += event.usage.reasoning_output_tokens ?? 0;
  }
  return found ? { input, output, cacheRead, cacheWrite, reasoning } : undefined;
}

/**
 * Run one single-shot role through an official subscription CLI. cwd is a
 * fresh empty temp dir; the CLI's own tools find nothing there
 * (instructed-only isolation — recorded honestly by callers). No timeout:
 * audit and reconstruction work is never clocked. Output comes from the
 * {out} file when the template names one (codex), else stdout (claude).
 * Per-call token usage is parsed from the CLI's machine-readable output
 * when present (telemetry only — absence never fails the call).
 */
function runCliRole(
  provider: keyof typeof CLI_BACKENDS,
  modelId: string,
  fullPrompt: string,
): Promise<{ text: string; usage?: RoleUsage }> {
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
          return resolve({ text: payload.text.trim() });
        } catch {
          return reject(new Error(`${provider} returned non-JSON output (exit ${code}): ${err.slice(0, 300)}`));
        }
      }
      if (code !== 0) return reject(new Error(`${provider} exited ${code}: ${err.slice(0, 500)}`));
      if (backend.output === "claude-json") {
        try {
          const payload = JSON.parse(out) as ClaudeJsonResult;
          if (payload.is_error) return reject(new Error(`${provider} reported an error result`));
          const u = payload.usage;
          return resolve({
            text: (payload.result ?? "").trim(),
            usage: u && {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0,
            },
          });
        } catch {
          // Env-overridden template without --output-format json: plain text.
          return resolve({ text: out.trim() });
        }
      }
      if (backend.output === "outfile" && fs.existsSync(outFile)) {
        return resolve({ text: fs.readFileSync(outFile, "utf-8").trim(), usage: backend.usage?.(out) });
      }
      resolve({ text: out.trim() });
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

export interface RoleSession {
  ask(prompt: string): Promise<string>;
  /** Context size in tokens from pi's estimator over the session's context messages. */
  approxTokens(): number;
  /** Cumulative provider-reported token usage across the session's calls. */
  usage(): RoleUsage;
  /** In-place lossy compaction (harness-backed sessions only): summarize
   *  older turns, keep a recent tail verbatim. The caller owns the policy
   *  and the contract's post-compaction reread rule. */
  compact?(customInstructions?: string): Promise<void>;
  /** Inject a steering message while the session is running. */
  steer(text: string): void;
  /** Abort the session's current run. */
  abort(): void;
}

/** Wire-log hooks (COVERIFY_WIRE_LOG=/path): each request's SHAPE via pi's
 *  native onPayload/onResponse — cache key, item counts, sizes, status, and
 *  rate-limit headers; never content. Telemetry only, failures swallowed. */
function wireLogPayload(wirePath: string) {
  return (payload: unknown, m: unknown) => {
    try {
      const params = payload as Record<string, unknown>;
      const input = params.input as unknown[] | undefined;
      const instructions = params.instructions as string | undefined;
      fs.appendFileSync(
        wirePath,
        JSON.stringify({
          ts: Date.now(),
          kind: "request",
          model: (m as { id?: string })?.id ?? String(params.model ?? ""),
          prompt_cache_key: params.prompt_cache_key,
          store: params.store,
          input_items: Array.isArray(input) ? input.length : undefined,
          instructions_chars: typeof instructions === "string" ? instructions.length : undefined,
          tools: Array.isArray(params.tools) ? (params.tools as unknown[]).length : undefined,
          reasoning: params.reasoning,
          keys: Object.keys(params),
        }) + "\n",
      );
    } catch {
      /* telemetry only */
    }
    return undefined;
  };
}


/** Provider-reported token usage (pi-ai Usage, summed; official CLIs parsed
 *  from their JSON output) — mechanics only; nothing reads this except the
 *  journal. */
export interface RoleUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  /** Dollar cost summed from pi's per-message pricing (absent for CLI backends). */
  costUSD?: number;
}

function sumMessagesUsage(messages: readonly unknown[]): RoleUsage {
  const total: RoleUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const m of messages) {
    const u = (m as { role?: string; usage?: RoleUsage & { cost?: { total?: number } } }).usage;
    if ((m as { role?: string }).role !== "assistant" || !u) continue;
    total.input += u.input ?? 0;
    total.output += u.output ?? 0;
    total.cacheRead += u.cacheRead ?? 0;
    total.cacheWrite += u.cacheWrite ?? 0;
    if (u.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + u.reasoning;
    if (u.cost?.total !== undefined) total.costUSD = (total.costUSD ?? 0) + u.cost.total;
  }
  return total;
}

interface RoleResult {
  text: string;
  /** Undefined when the backend reported no usage (e.g. an env-overridden CLI template without JSON output). */
  usage?: RoleUsage;
  /** Request-shape telemetry for single-shot roles (their only "turn"). */
  promptChars?: number;
  durationMs?: number;
}

/**
 * In-memory single-use session: one Agent instance, used only by runRole for
 * single-shot verdict roles on API providers. The coordinator and dispatched
 * agents run as durable sessions via createHarnessRoleSession (harness.ts).
 */
function createRoleSession(
  run: Omit<RoleRun, "prompt"> & { prompt?: string },
): Pick<RoleSession, "ask" | "usage"> {
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
  // Stable per-call prompt-cache key: pi derives prompt_cache_key from
  // options.sessionId, so the single-shot's tool-loop turns hit the provider
  // prefix cache (~80% measured, see f0ad016). 36-char UUID ≤ 64-char limit.
  const cacheSessionId = randomUUID();
  const agent = new Agent({
    initialState: {
      systemPrompt: systemText(run),
      model: getModel(run.models, run.spec),
      thinkingLevel: run.spec.thinking,
      tools,
    },
    streamFn: run.models.streamSimple.bind(run.models),
    sessionId: cacheSessionId,
    ...(process.env.COVERIFY_WIRE_LOG
      ? { onPayload: wireLogPayload(process.env.COVERIFY_WIRE_LOG) }
      : {}),
  });
  return {
    async ask(prompt: string): Promise<string> {
      await agent.prompt(prompt);
      return finalText(agent);
    },
    usage(): RoleUsage {
      return sumMessagesUsage(agent.state.messages);
    },
  };
}

export interface HarnessSessionOpts {
  /** Stable session identity: names the JSONL session and becomes the
   *  provider's prompt_cache_key (keep ≤64 chars). */
  sessionId: string;
  /** Directory for durable session trees (e.g. <campaign>/.coverify/sessions). */
  sessionsRoot: string;
  cwd: string;
}

/**
 * Durable role session on pi's AgentHarness (redesign phase 1): the durable
 * analog of createRoleSession, implementing the full RoleSession surface
 * (telemetry, compaction, steering) that the in-memory single-shot path does
 * not. The transcript is an append-only JSONL session tree on disk —
 * crash-survivable, forkable, and the raw material for telemetry. Chosen over pi-coding-agent's
 * createAgentSession because the harness layer takes systemPrompt verbatim
 * (prompt purity by construction), our Models instance directly, and plain
 * AgentTools, with zero disk/env discovery (docs/redesign-proposal.md).
 * prompt_cache_key threads automatically from the session id.
 */
export async function createHarnessRoleSession(
  run: Omit<RoleRun, "prompt"> & { prompt?: string },
  opts: HarnessSessionOpts,
): Promise<RoleSession> {
  if (isCliProvider(run.spec.provider)) {
    throw new Error("CLI backends support single-shot verdict roles only, not sessions");
  }
  const tools: AgentTool[] = run.workspace
    ? workspaceTools(run.workspace.cwd, run.workspace.scope, {
        code: run.workspace.code,
        literature: run.workspace.literature,
      })
    : [];
  if (run.extraTools) tools.push(...run.extraTools);
  const env = new NodeExecutionEnv({ cwd: opts.cwd });
  const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: opts.sessionsRoot });
  const session = await repo.create({ cwd: opts.cwd, id: opts.sessionId });
  const harness = new AgentHarness({
    session,
    models: run.models,
    model: getModel(run.models, run.spec),
    thinkingLevel: run.spec.thinking,
    // Verbatim — the harness layer performs no prompt assembly of its own.
    systemPrompt: systemText(run),
    tools,
    activeToolNames: tools.map((t) => t.name),
    resources: {},
  });
  // Wire logging via the harness's own hooks (the Agent-ctor onPayload path
  // does not exist at this layer — review 2026-08-02 caught the silent loss).
  const wirePath = process.env.COVERIFY_WIRE_LOG;
  if (wirePath) {
    const logPayload = wireLogPayload(wirePath);
    harness.on("before_provider_payload", (e) => {
      logPayload((e as { payload?: unknown }).payload, (e as { model?: unknown }).model);
      return undefined;
    });
    // Response-side records (status, rate-limit headers) are NOT available:
    // pi 0.83.0 types after_provider_response but never emits it on this
    // provider path (verified empirically 2026-08-02 — neither .on() nor
    // subscribe() ever sees it, and the Agent-path onResponse never fired
    // either). Revisit on pi upgrade; until then the wire log is
    // request-side only.
  }
  // Sync RoleSession surface over async session storage: the message cache
  // refreshes after every completed run (telemetry reads between runs).
  // Two views on purpose: `allMessages` (every message ever, across all
  // branches — usage totals never un-count compacted spend) vs
  // `contextMessages` (session.buildContext() — what the model actually
  // sees next call).
  let allMessages: AgentMessage[] = [];
  let contextMessages: AgentMessage[] = [];
  let compactionUsage: RoleUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const refresh = async () => {
    // getEntries (not getBranch): usage/turn totals must keep counting
    // everything ever spent — including entries a compaction superseded.
    const entries = await session.getEntries();
    allMessages = entries.flatMap((e) => (e.type === "message" ? [e.message] : []));
    // The summarization call's own spend lives on the compaction entry, not
    // on any assistant message — without this, every compaction's large
    // request would vanish from the usage journal (review 2026-08-02).
    compactionUsage = sumMessagesUsage(
      entries.flatMap((e) =>
        e.type === "compaction" && (e as { usage?: unknown }).usage
          ? [{ role: "assistant", usage: (e as { usage?: unknown }).usage }]
          : [],
      ),
    );
    contextMessages = (await session.buildContext()).messages;
  };
  const addUsage = (a: RoleUsage, b: RoleUsage): RoleUsage => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    costUSD: (a.costUSD ?? 0) + (b.costUSD ?? 0),
  });
  return {
    async ask(prompt: string): Promise<string> {
      let final;
      try {
        final = await harness.prompt(prompt);
      } finally {
        // Telemetry must reflect spend even when the run rejects — a failed
        // 500k-token run recorded as zero usage is worse than the failure.
        await refresh().catch(() => {});
      }
      // The harness resolves failures as a synthetic message; surface the
      // real cause instead of an empty string (which would read as the
      // empty-report infra failure and trigger a pointless salvage nudge).
      if (final.stopReason === "error") {
        throw new Error(final.errorMessage ?? "provider error (no message)");
      }
      if (final.stopReason === "aborted") return "";
      if (typeof final.content === "string") return final.content;
      return (final.content ?? [])
        .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
        .map((b) => b.text)
        .join("\n");
    },
    approxTokens(): number {
      return estimateContextTokens(contextMessages).tokens;
    },
    usage(): RoleUsage {
      return addUsage(sumMessagesUsage(allMessages), compactionUsage);
    },
    async compact(customInstructions?: string): Promise<void> {
      await harness.compact(customInstructions);
      await refresh();
    },
    steer(text: string): void {
      // AgentHarness.steer REJECTS when idle (worker just finished): a
      // dropped steer is routine, an unhandled rejection kills the process.
      harness.steer(text).catch(() => {});
    },
    abort(): void {
      harness.abort().catch(() => {});
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
changes to citable artifacts get a new revision-suffixed filename. Per the contract, a candidate
revision contains only content submitted for promotion: state every unboundedly quantified claim
as an explicit theorem or lemma with its hypotheses and quantifiers exposed, keep finite directly
checkable content (a particular witness, its arithmetic, bounded tables) clearly separate from the
theorems it supports, and put supporting notes in ordinary evidence artifacts instead. Return a
conclusion-first report: the deliverable — a proved lemma, explicit construction,
counterexample/certificate — or the precise failing implication with evidence. Status reports and vague optimism are not
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
you can check what is actually promoted. Refute the candidate. Per the contract, finite directly
checkable content (a particular witness and its arithmetic, bounded tables) is verified by YOUR
outright check — reconstruction structurally cannot reach it, so your verification of it is the
only one it gets; and an unboundedly quantified claim asserted only in passing prose, rather than
as an explicit theorem or lemma with exposed hypotheses and quantifiers, is a concrete defect.
Your VERY FIRST line must be exactly
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
the point. Per the contract, the reconstruction owes exactly the candidate's theorem-class claims:
for an existential theorem, a reconstruction establishing existence through a different valid
witness is PASS, and finite directly checkable content verified at stage 1 (a particular witness,
its arithmetic, bounded tables) is not a mismatch when absent from the reconstruction, provided
every theorem-class claim it supports is established. A concrete mismatch is: a theorem-class
conclusion not established (including established only in a
weaker or nearby form), or reliance on material outside the declared dependencies and bundle. Use
the frozen statement and the candidate's declared contract; do not invent a stronger output
requirement and fail the candidate for omitting it. Your VERY FIRST line must be exactly
VERDICT: PASS or VERDICT: FAIL; then the mapping (on PASS) or the concrete mismatch (on FAIL).`,
} as const;
