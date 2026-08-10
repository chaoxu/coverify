// OS supervision and confinement mechanics — the semantics-invisible lane
// (design rule 2): reaper hooks, sandboxed argv-only execution, batch caps,
// result caps, write-scope resolution and checks. The launcher-clause
// enforcement lane (the role tool surface) is workspace.ts, which imports this
// module; the edge never points back. Role prompt text is in roles.ts.
import { execFile, spawn, spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { repoRoot } from "./campaign.js";

export const OUTPUT_LIMIT = 50_000;
/**
 * Live batch reapers. Every supervised batch registers one so a harness that
 * dies takes its compute with it; without this the scripts are detached process
 * groups with no watchdog left.
 */
export const liveReapers = new Set<() => void>();
let reaperHooksInstalled = false;
export function installReaperHooks(): void {
  if (reaperHooksInstalled) return;
  reaperHooksInstalled = true;
  const reapAll = () => {
    // Drained, not iterated: process.exit() inside the signal handlers fires the
    // `exit` listener, which reaps a second time — and a double-kill on a pid
    // that has since been reused is not harmless. Draining makes the second pass
    // a no-op structurally rather than by downstream idempotence.
    const pending = [...liveReapers];
    liveReapers.clear();
    for (const reap of pending) {
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
  // NO uncaughtException/unhandledRejection handlers, deliberately: on Bun both
  // an unhandled rejection and an uncaught throw run `exit` listeners, so the
  // hook above already reaps (measured). Adding them replaces Bun's
  // source-mapped crash output with a bare stack and creates a double-reap.
}

/** A malformed limit must not silently become NaN: setTimeout(fn, NaN) fires
 *  immediately, which would time out every batch instantly. */
export function envNumber(raw: string | undefined, fallback: number, min: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= min ? n : fallback;
}
const positiveEnvNumber = (raw: string | undefined, fallback: number) => envNumber(raw, fallback, 1);

/** Wall limit for one run_script batch / one librarian call. Never a proof-work
 *  timebox (the launcher forbids those) — supervision only. Read at call time,
 *  never frozen at module load: tests and wrappers set these envs after import,
 *  and a value captured at import silently ignores them. */
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
 * unrestricted. On non-darwin the backend is @landstrip/landstrip (Landlock +
 * seccomp, kernel-enforced, no root): same WriteScope semantics plus
 * deny-default networking. Without that binary the argv runs unsandboxed and
 * write confinement degrades to instructed-only — loudly.
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

/** Whether the sandbox can ACTUALLY confine, not whether a file is present.
 *
 *  `LANDSTRIP_BIN` is the JS shim, which `bun install` puts on every platform
 *  including macOS and Windows. The enforcing part is a per-platform optional
 *  dependency, and behind that is a kernel feature that may be absent
 *  (a container without Landlock, an unsupported arch). Testing only for the
 *  shim reported `landlock` — and stamped it into the run config as a
 *  threat-model fact — while every technician script actually died with "the
 *  landstrip binary package is not installed", read inside the campaign as a
 *  script failure rather than as lost confinement. `landstrip doctor` exists
 *  precisely to answer this, so ask it. */
function landstripAvailable(): boolean {
  if (!landstripChecked) {
    landstripChecked = true;
    landstripUsable = fs.existsSync(LANDSTRIP_BIN) && landstripDoctorPasses();
    if (!landstripUsable) {
      console.error(
        "[coverify] landstrip cannot confine on this host — non-darwin write confinement is " +
          "INSTRUCTED-ONLY for this run (missing binary, unsupported platform, or no kernel " +
          "Landlock support; `bun install` restores the binary, the kernel feature it cannot)",
      );
    }
  }
  return landstripUsable;
}

/** Ask landstrip whether the platform sandbox is usable. A failure here is
 *  always "cannot confine": this must never throw, because reporting confinement
 *  optimistically is the failure it exists to prevent. */
function landstripDoctorPasses(): boolean {
  try {
    return spawnSync(LANDSTRIP_BIN, ["doctor"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

/** WriteScope → landstrip policy JSON. Reads stay unrestricted (fields
 *  omitted); network deny-default is landstrip's default, stated explicitly.
 *  Deny targets need no existence dance here: landstrip evaluates globs at
 *  access time, covering the not-yet-existing forged-PROVED.md case. */
function landstripPolicy(scope: WriteScope): object {
  // Canonical paths only: landstrip refuses deny targets reachable through a
  // symlinked ancestor of an allow root (POLICY_DENY_WRITE_SYMLINK_ANCESTOR),
  // e.g. /tmp -> /private/tmp.
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

/** Fully resolve a path, including the final component when it exists: a symlink
 *  the role created inside its own directory must be judged by its target, or
 *  scope checks are decorative. Nonexistent components are appended to the
 *  deepest resolved ancestor. */
export function realResolve(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    try {
      return fs.realpathSync.native(abs);
    } catch {
      /* raced away; fall through to the ancestor walk */
    }
  }
  // A symlink whose target does not exist yet: existsSync follows links and says
  // false, so the link would be judged as itself while the kernel writes through
  // it. A dangling link pointed at PROVED.md is how a write escapes its scope.
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
 * Whole-token only: a substring test would adopt — and SIGKILL — any unrelated
 * process whose arguments merely mention the path.
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
 * reaper so a dying harness takes the compute with it. EVERY path that executes
 * anything goes through here, so none becomes a doorway to the uncapped runaway
 * that kernel-panicked the host on 2026-08-01.
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
        // A silently absent cap is worse than a loud stop.
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
