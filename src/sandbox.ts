// OS supervision and confinement mechanics — the semantics-invisible lane
// (design rule 2): reaper hooks, sandboxed argv-only execution, batch caps,
// result caps, write-scope resolution and checks. Removable without changing
// what a campaign concludes.
// The launcher-clause enforcement lane — the role tool surface — lives in
// workspace.ts, which imports this module; the edge never points back.
// Role prompt text does NOT live here (LIBRARIAN_CHARGE is in roles.ts).
import { execFile, spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { repoRoot } from "./campaign.js";

export const OUTPUT_LIMIT = 50_000;
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
  // A crash is a way the harness dies too, and it was the one path that left
  // compute running. The stated threat model is "a harness that dies takes its
  // compute with it" — an unhandled throw or rejection is exactly that, and
  // Node's default handler exits without running `exit` listeners for a
  // rejection. Re-thrown after reaping so the failure is still loud and the
  // exit code still says crash. (signal-exit does this too; two lines and no
  // dependency in the security-critical module wins here.)
  for (const fatal of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(fatal, (err: unknown) => {
      reapAll();
      console.error(`[coverify] ${fatal}; reaped live compute before exiting`);
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
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

export function sandboxedArgv(argv: string[], scope: WriteScope): { file: string; args: string[] } {
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
export function realResolve(p: string): string {
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
export const under = (child: string, root: string) =>
  child === root || child.startsWith(root + path.sep);

export function inScope(scope: WriteScope, target: string): boolean {
  const real = realResolve(target);
  const allowed = scope.allow.some((root) => under(real, realResolve(root)));
  const denied = scope.deny.some((root) => {
    const r = realResolve(root);
    return under(real, r) || under(real.toLowerCase(), r.toLowerCase());
  });
  return allowed && !denied;
}

export function assertInScope(scope: WriteScope, target: string): void {
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

export interface SupervisedOut {
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
export async function supervise(
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
