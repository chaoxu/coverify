// OS supervision and confinement — TWO LANES, named honestly (2026-08-09
// architecture review; the old header claimed "never about campaign policy"):
// (1) semantics-invisible mechanics (design rule 2): reaper hooks, sandboxed
//     argv-only execution, batch caps, result caps, read-scope transport;
// (2) launcher-clause enforcement (design rule 1), because the tool surface
//     is where these clauses bite: append-only ledgers (APPEND_ONLY_LEDGERS),
//     preregistered-code-only writes (PROSE_EXTS), literature-report
//     provenance names, and the campaign read scope derived from the
//     user-frozen STATEMENT.md. Conformance rows live in docs/design.md.
// Role prompt text does NOT live here (LIBRARIAN_CHARGE is in roles.ts).
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { type AgentTool } from "@earendil-works/pi-agent-core";
import { campaignExists, repoRoot } from "./campaign.js";
import { LIBRARIAN_CHARGE } from "./roles.js";
import {
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OUTPUT_LIMIT = 50_000;
/**
 * Live batch reapers. Every supervised batch registers one so that a harness
 * that dies — operator Ctrl-C on a machine being eaten, a crash, an OOM kill —
 * takes its compute with it. Without this the scripts are detached process
 * groups with no watchdog left: exactly the uncapped runaway this layer
 * exists to prevent.
 */
export const liveReapers = new Set<() => void>();
let reaperHooksInstalled = false;
export function installReaperHooks(): void {
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
  // SIGQUIT included: detached CLI children no longer share the terminal's
  // foreground group, so JS hooks are their only kill path short of SIGKILL.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.on(sig, () => {
      reapAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/** A malformed limit must not silently become NaN: setTimeout(fn, NaN) fires
 *  immediately, which would time out every batch instantly. */
export function envNumber(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= min ? n : fallback;
}
const positiveEnvNumber = (raw: string | undefined, fallback: number) => envNumber(raw, fallback, 1);

/** Wall limit for one run_script batch / one librarian call. Never a
 *  proof-work timebox (the launcher forbids those) — supervision only. */
// Read at call time, never frozen at module load: tests and wrappers set
// these envs after import, and a value captured at import silently ignores
// them (caught live when a new test file changed the suite's import order).
export const runTimeoutMs = () => positiveEnvNumber(process.env.COVERIFY_RUN_TIMEOUT_MS, 600_000);

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
const LANDSTRIP_BIN = path.join(repoRoot(), "node_modules", ".bin", "landstrip");
let landstripChecked = false;
let landstripUsable = false;
/** Which write-confinement backend is actually in force — a threat-model
 *  fact for the run-config stamp (degradation was console.error-only). */
export function sandboxMode(): "seatbelt" | "landlock" | "instructed-only" {
  if (process.platform === "darwin") return "seatbelt";
  return landstripAvailable() ? "landlock" : "instructed-only";
}

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
  // A symlink whose target does not exist yet: existsSync follows links and
  // says false, so the link would be judged as itself while the kernel writes
  // through it. Resolve the link by hand — a dangling link pointed at
  // PROVED.md is exactly how a write escapes its scope.
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      const resolved = path.resolve(path.dirname(abs), target);
      // Bounded: a link chain is followed by recursion, and a cycle throws
      // ELOOP from lstat/readlink long before this matters.
      return resolved === abs ? resolved : realResolve(resolved);
    }
  } catch {
    /* not a link, or unreadable: fall through to the ancestor walk */
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
const under = (child: string, root: string) => child === root || child.startsWith(root + path.sep);

function inScope(scope: WriteScope, target: string): boolean {
  const real = realResolve(target);
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

export const runMemMb = () => positiveEnvNumber(process.env.COVERIFY_RUN_MEM_MB, 4096);

/**
 * Does this command line name one of the batch's scripts as an argument?
 *
 * Whole-token only. A substring test would adopt — and then SIGKILL — any
 * unrelated process whose arguments merely mention the path, which on a shared
 * working directory means other agents, editors, and dev servers.
 */
function namesAMark(args: string, marks: readonly string[]): boolean {
  if (marks.length === 0) return false;
  for (const token of args.split(/\s+/)) {
    const bare = token.replace(/^["']|["'],?$/g, "");
    for (const m of marks) {
      if (bare === m || bare.startsWith(m + "/")) return true;
    }
  }
  return false;
}

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
        if (roots.has(pid) || roots.has(r.pgid) || namesAMark(r.args, marks)) {
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
export function runScriptTool(
  cwd: string,
  scope: WriteScope,
  opts?: { exclusiveDir?: boolean },
): AgentTool {
  return {
    name: "run_script",
    label: "Run scripts",
    description:
      `Run 1-8 script files concurrently, supervised, under ONE shared cap. Working directory: ${cwd}. ` +
      "Each script must be a file inside your assigned directory: a .py runs under python3, " +
      "anything else must be executable. Write scripts with the write tool first. Limits for the " +
      `whole batch: ${Math.round(runTimeoutMs() / 60000)} minutes, ${runMemMb()} MB combined RSS; ` +
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
      // Sweep marks. The batch's own script paths are always safe to match.
      // The working directory is added only when it belongs exclusively to
      // this batch (a dispatched agent's own evidence directory): that is what
      // catches a helper launched in a new session running a *different* file
      // there. On a shared directory — vanilla pi opened on a project — the
      // same match would adopt and kill other agents' processes, so it is
      // omitted and that recall is given up deliberately.
      const marks = jobs.map((j) => j.script);
      if (opts?.exclusiveDir) marks.push(cwd);
      const { outs, fate } = await supervise(
        jobs.map(({ argv }) => sandboxedArgv(argv, scope)),
        { cwd, marks, signal },
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
  opts: {
    cwd: string;
    marks?: readonly string[];
    signal?: AbortSignal;
    outputLimit?: number;
    /** Wall override (hang protection for thinking CLIs); defaults to the
     *  run_script batch cap, which remains the compute host-protection wall. */
    timeoutMs?: number;
  },
): Promise<{ outs: SupervisedOut[]; fate?: string }> {
  const limit = opts.outputLimit ?? OUTPUT_LIMIT;
  const marks = opts.marks ?? [];
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
      const sweep = await processSweep(roots, marks).catch(() => undefined);
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
  const wallMs = opts.timeoutMs ?? runTimeoutMs();
  const timer = setTimeout(() => {
    if (finished) return;
    fate = `timed out after ${Math.round(wallMs / 60000)} minutes`;
    void killAll();
  }, wallMs);
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
    processSweep(roots, marks).then(
      ({ rssKb }) => {
        // `finished` is re-read here: a sweep in flight when the batch ended
        // must not report a completed run as killed.
        if (fate || finished) return;
        if (rssKb > runMemMb() * 1024) {
          fate = `exceeded the ${runMemMb()} MB combined memory cap (rss ${Math.round(rssKb / 1024)} MB)`;
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
const literatureCmd = () =>
  (process.env.COVERIFY_LITERATURE_CMD ?? "agy --dangerously-skip-permissions --print-timeout 168h -p").split(
    /\s+/,
  );

/**
 * State directories the librarian CLI may write (token refresh, cache).
 * Deliberately narrow: `~/.claude`, `~/.codex`, and `~/.config` hold settings
 * and hook files that execute on a later run — and coverify's own OAuth store
 * lives in `~/.config/coverify` — so a role-authored prompt must not reach
 * them. Override for a different librarian binary with
 * COVERIFY_LITERATURE_STATE_DIRS (colon-separated absolute paths).
 */
const librarianStateDirs = () =>
  (
    process.env.COVERIFY_LITERATURE_STATE_DIRS?.split(":").filter(Boolean) ??
    [".gemini", ".antigravity"].map((d) => path.join(os.homedir(), d))
  ).filter((d) => path.isAbsolute(d) && d !== os.homedir());

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
      `${Math.round(runTimeoutMs() / 60000)}-minute limit.`,
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
      const spec = sandboxedArgv([...literatureCmd(), LIBRARIAN_CHARGE + question], {
        allow: [...scope.allow, ...librarianStateDirs()],
        deny: scope.deny,
      });
      const { outs, fate } = await supervise([spec], {
        cwd,
        signal,
        outputLimit: OUTPUT_LIMIT * 4,
        // 7-day wall: hang protection, never a search-work limit (user
        // decision, Chao 2026-08-09). The 10-minute batch cap is for
        // host-protection of computation, not for a thinking librarian.
        timeoutMs: 7 * 24 * 3_600_000,
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
        `# Literature search ${n}\n\nLibrarian: \`${literatureCmd().join(" ")}\` (self-attested provenance)\n\n## Question\n\n${question}\n\n## Report\n\n${stdout}\n`,
      );
      let out = stdout;
      if (out.length > OUTPUT_LIMIT) out = out.slice(0, OUTPUT_LIMIT) + "\n[truncated; full report in artifact]";
      return toolText(`[archived: ${artifact}]\n\n${out}`);
    },
  } as AgentTool;
}

/**
 * Read scope: a role may read only campaign content — the campaign tree plus
 * the prior-route paths its STATEMENT.md declares (both are model-written
 * campaign material; the statement is user-frozen). Nothing else: on
 * 2026-08-09 workers literature-hunted with grep over all of $HOME and other
 * agents' caches, blowing their sessions past the model context window
 * (issue #22) and leaking unrelated files into provider-bound prompts.
 * External questions belong to literature_search.
 */
export function readRoots(cwd: string): string[] {
  // The campaign root is the nearest ancestor holding STATEMENT.md — cwd is
  // a worker's evidence dir or the campaign dir itself.
  let root = realResolve(cwd);
  for (let d = root; ; d = path.dirname(d)) {
    if (campaignExists(d)) {
      root = d;
      break;
    }
    if (d === path.dirname(d)) break;
  }
  const roots = [root];
  try {
    const stmt = fs.readFileSync(path.join(root, "STATEMENT.md"), "utf-8");
    // Path-like tokens: ~/x, /x, or ../x (relative to the campaign root, the
    // lin3cut convention for sibling campaigns). The preceding character must
    // not be a word char or ':', so `https://host/tmp` does not grant /tmp.
    // Trailing sentence punctuation is stripped ("... at ~/research/x." must
    // not silently drop the root). Only existing paths at depth >= 3 count —
    // a bare `/var` or `/tmp` mentioned in prose is never a read grant.
    for (const m of stmt.matchAll(/(?:^|[^\w:])((?:~\/|\.\.\/|\/)[\w.@+-][\w.@/+-]*)/g)) {
      const tok = (m[1] ?? "").replace(/[.,;:!?]+$/, "");
      if (!tok) continue;
      const abs = tok.startsWith("~/") ? path.join(os.homedir(), tok.slice(2)) : path.resolve(root, tok);
      if (abs.split(path.sep).filter(Boolean).length < 3) continue;
      if (fs.existsSync(abs)) roots.push(realResolve(abs));
    }
  } catch {
    /* foreign campaign without a statement: campaign tree only */
  }
  return roots;
}

/** Mirror of pi's resolveToCwd (core/tools/path-utils.ts, 0.83.0): the read
 *  tools strip a leading '@', expand `~`, and accept file:// URLs BEFORE
 *  touching the filesystem — so the guard must judge the path the tool will
 *  actually use. Judging the raw param lets `grep {path: "~"}` resolve to
 *  `<evidenceDir>/~` for the check and to $HOME for the search — reopening
 *  the exact issue-#22 hole. (Deep-importing pi's helper is blocked by its
 *  package exports map; drift is pinned by tests/read-scope.test.ts.) */
function normalizeLikePi(v: string, cwd: string): string {
  let s = v.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  if (/^file:\/\//.test(s)) s = fileURLToPath(s);
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(cwd, s);
}

const COVERIFY_STATE_RE = /(^|\/)\.coverify(\/|$)/;

/** Drop grep/ls result lines whose LEADING PATH sits under .coverify/:
 *  ripgrep runs with --hidden, so a pathless or campaign-root grep would
 *  otherwise return journal and session-transcript lines — a verification-
 *  blindness leak the param check alone cannot stop (the param was in
 *  scope). Anchored to the relpath prefix of grep's `path:line:` / `path-
 *  line-` and ls's bare-entry formats: a result line whose CONTENT merely
 *  mentions .coverify/ (after the separator) is legitimate and kept — which
 *  is also why the read tool (raw file content, no path prefix) is exempt. */
function dropCoverifyLines(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((l) => {
    // Extract the leading path structurally, then judge it segment-exact:
    // grep match/context lines are "<path>:12: text" / "<path>-12- text"
    // (pi builds both; the \d+ requirement keeps a ':' or '-' inside a
    // directory name from ending the path early); anything else (ls
    // entries) is judged whole. Character-class prefix guessing broke both
    // ways — paths with spaces leaked, .coverify-* siblings were dropped.
    const m = /^(.*?)[:-]\d+[:-] /.exec(l);
    const prefix = m?.[1] ?? l.trimEnd();
    return !COVERIFY_STATE_RE.test(prefix);
  });
  const dropped = lines.length - kept.length;
  return dropped === 0 ? text : `${kept.join("\n")}\n[${dropped} line(s) under .coverify/ withheld: harness state]`;
}

function dropCoverifyResult(result: Awaited<ReturnType<AgentTool["execute"]>>): typeof result {
  return {
    ...result,
    content: result.content.map((b) => (b.type === "text" ? { ...b, text: dropCoverifyLines(b.text) } : b)),
  };
}

/** Cap a read-tool result's text to OUTPUT_LIMIT chars — the same bound
 *  run_script output gets. 130k-char grep results were a direct cause of the
 *  issue-#22 worker context overflows; the full file is always re-readable
 *  with a narrower query. */
function capResultText(result: Awaited<ReturnType<AgentTool["execute"]>>): typeof result {
  let budget = OUTPUT_LIMIT;
  const content = result.content.map((block) => {
    if (block.type !== "text") return block;
    if (block.text.length <= budget) {
      budget -= block.text.length;
      return block;
    }
    const kept = budget;
    budget = 0;
    return {
      ...block,
      text:
        block.text.slice(0, kept) +
        `\n[truncated: result exceeded the ${OUTPUT_LIMIT}-char read budget; narrow the query]`,
    };
  });
  return { ...result, content };
}

function confineReads(tool: AgentTool, roots: string[], cwd: string): AgentTool {
  // Result-side .coverify filtering applies to the directory-traversing tools
  // (grep/ls, whose lines carry a path prefix); read returns raw file content
  // where a .coverify mention is content, not a leak.
  const filterResults = tool.name !== "read";
  const guard = (r: Awaited<ReturnType<AgentTool["execute"]>>) =>
    capResultText(filterResults ? dropCoverifyResult(r) : r);
  // Stated up front in the schema so roles do not discover the fence by
  // bumping into it (63 refusal round-trips measured on the first night).
  const scopeNote =
    " Readable scope: this campaign's directory and the prior-route paths its STATEMENT.md " +
    "declares; .coverify/ is harness state and is never readable. Results are capped at " +
    `${OUTPUT_LIMIT} chars — narrow queries beat broad sweeps.`;
  const execute: AgentTool["execute"] = async (toolCallId, params, signal, onUpdate) => {
    const rec = (params ?? {}) as Record<string, unknown>;
    // All three pi tools name their path parameter `path` (read/ls/grep
    // schemas, verified 0.83.0); grep's is optional and defaults to cwd,
    // which is in scope by construction.
    {
      const v = rec.path;
      if (typeof v !== "string" || v.trim() === "") {
        return guard(await tool.execute(toolCallId, params, signal, onUpdate));
      }
      const real = realResolve(normalizeLikePi(v, cwd));
      if (!roots.some((r) => under(real, r))) {
        return toolText(
          `READ SCOPE REFUSED: ${v} is outside this campaign's read scope — the campaign ` +
            "directory and the prior-route paths STATEMENT.md declares. For literature or any " +
            "other external material, use literature_search (if granted) or state the need in " +
            "your report.",
        );
      }
      // Harness state is never reasoning material: journals, session
      // transcripts, and gate mirrors live under .coverify/, and reading a
      // transcript would also breach verification blindness (another agent's
      // reasoning must stay unseen).
      if (COVERIFY_STATE_RE.test(real)) {
        return toolText(
          `READ SCOPE REFUSED: ${v} is harness state (.coverify/ journals and transcripts), ` +
            "not campaign reasoning material. Read the ledgers and EVIDENCE/ instead.",
        );
      }
    }
    // Result-side filtering as well: an in-scope directory grep/ls still
    // traverses .coverify/ (ripgrep runs --hidden), so matched transcript
    // lines are withheld even when the param was legal.
    return guard(await tool.execute(toolCallId, params, signal, onUpdate));
  };
  return { ...tool, description: `${tool.description}${scopeNote}`, execute };
}

/**
 * The role tool surface for a workspace: pi's read-only file tools
 * (read, ls, grep) — confined to readRoots(cwd) — and pi's write tool wrapped
 * with the role's write scope.
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
  const roots = readRoots(cwd);
  const tools = [
    ...[createReadTool(cwd), createLsTool(cwd), createGrepTool(cwd)].map((t) =>
      confineReads(t as AgentTool, roots, cwd),
    ),
    scopedWrite,
  ] as AgentTool[];
  if (code) tools.push(runScriptTool(cwd, scope, { exclusiveDir: true }));
  if (opts?.literature === true) tools.push(literatureSearchTool(cwd, scope));
  return tools;
}
