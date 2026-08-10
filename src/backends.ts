// Subscription CLI transports for the single-shot verdict roles: command
// templates, process-group kill/reaper wiring, output/usage parsing. Mechanics
// (design rule 2) with one exception — the served-model attestation policy on
// the oracle-json path (user policy 2026-08-09; issue #20) lives here because
// it is a property of the reply, enforced where the reply is parsed.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { repoRoot } from "./campaign.js";
import { claudeJsonUsage, codexJsonlUsage } from "./cli-usage.js";
import { installReaperHooks, liveReapers } from "./sandbox.js";
import type { RoleRun, RoleSession, RoleUsage } from "./providers.js";

/** A CLI failure that still cost money: the provider was paid before it exited
 *  nonzero, so the rejection carries the spend and its join keys. One shape for
 *  the writer here and the reader in cadence.ts. */
export interface BilledFailure extends Error {
  usage?: RoleUsage;
  providerSessionId?: string;
  backendCwd?: string;
  /** Provider requests the failed call made; the attached `usage` sums them. */
  requests?: number;
  /** Set by whichever component journalled this spend first. The error is
   *  rethrown, so without a claim the cadence's leaf and the completion record
   *  both write the same tokens — one payment, two records. */
  usageLeafed?: true;
}

/**
 * A spawned official CLI as a degenerate RoleSession: answers exactly once, can
 * be stopped (kill) but not steered, holds no transcript, reports usage only
 * when its machine-readable output carried it.
 */
export function createCliRoleSession(
  run: Omit<RoleRun, "workspace" | "extraTools">,
  signal?: AbortSignal,
): RoleSession & { promptChars(): number } {
  const provider = run.spec.provider as keyof typeof CLI_BACKENDS;
  const stop = new AbortController();
  const onOuterAbort = () => stop.abort();
  if (signal?.aborted) stop.abort();
  else signal?.addEventListener("abort", onOuterAbort, { once: true });
  let usage: RoleUsage | undefined;
  let servedModel: string | undefined;
  let reportedModel: string | undefined;
  let providerSessionId: string | undefined;
  let backendCwd: string | undefined;
  let requests: number | undefined;
  let sentChars = 0;
  let asked = false;
  return {
    capabilities: { steerable: false, durable: false },
    async ask(prompt: string): Promise<string> {
      if (asked) throw new Error("a CLI oracle answers exactly once per dispatch");
      asked = true;
      const fullPrompt = `${systemText(run)}\n\n---\n\n${prompt}`;
      sentChars = fullPrompt.length;
      const r = await runCliRole(provider, run.spec.modelId, fullPrompt, stop.signal).catch(
        (e: BilledFailure) => {
          // The usage on the rejection SUMS all N turns, so leaving requests at
          // the floor of 1 reports N turns of tokens against one request.
          requests = e.requests;
          throw e;
        },
      );
      usage = r.usage;
      servedModel = r.servedModel;
      reportedModel = r.reportedModel;
      providerSessionId = r.providerSessionId;
      backendCwd = r.backendCwd;
      requests = r.requests;
      return r.text;
    },
    approxTokens: () => 0,
    usage: () => usage,
    // Server-attested served model: the honest value for a record's modelFamily
    // — the requested spec is testimony, this is attestation (issue #20).
    servedModel: () => servedModel,
    /** Self-reported model (claude-cli). Journal-only, never enforced (#21 P3).
     *  codex-cli emits no model echo in its JSONL (verified 2026-08-09). */
    reportedModel: () => reportedModel,
    unmetered: () =>
      CLI_BACKENDS[provider].unmetered && asked
        ? [{ lane: provider, detail: `${provider} reports no usage payload` }]
        : [],
    // Attempts is exact (one answer, no transcript). Requests is not: a codex
    // tool loop is several requests inside that one answer, so the
    // stream-derived count wins where the transport produces one.
    attempts: () => (asked ? 1 : 0),
    requests: () => requests ?? (asked ? 1 : 0),
    /** Join keys into the provider's own rollout (codex lane), where the
     *  rate-limit trajectory lives. Recorded, never interpreted here. */
    providerSessionId: () => providerSessionId,
    backendCwd: () => backendCwd,
    steer: () => Promise.resolve(false),
    abort: () => stop.abort(),
    promptChars: () => sentChars,
  };
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
  /** This lane reports no usage at all, so a record must carry the gap
   *  explicitly (absent ≠ zero; see RoleUsage in providers.ts). */
  unmetered?: true;
}

/** Subscription-billed official CLIs as verdict-role backends. Command
 *  templates are env-overridable so CLI flag drift never needs a harness
 *  release; {model} and {out} are substituted. Both official CLIs are asked
 *  for machine-readable output so per-call token usage reaches the journal
 *  (claude: result JSON on stdout; codex: JSONL events with turn usage);
 *  an env-overridden template without those flags degrades to text-only. */
const CLI_BACKENDS: Record<"claude-cli" | "codex-cli" | "chatgpt-cli" | "agy", CliBackend> = {
  "claude-cli": {
    env: "COVERIFY_CLAUDE_CMD",
    // --effort max (user decision 2026-08-08): the hostile audit is the one
    // cross-family check behind every promotion, and audits are ~1% of token
    // spend, so deeper thinking here is negligible.
    cmd: "claude -p --model {model} --effort max --output-format json",
    output: "claude-json",
  },
  "codex-cli": {
    env: "COVERIFY_CODEX_CMD",
    cmd: "codex exec --json --model {model} --sandbox read-only --skip-git-repo-check --output-last-message {out} -",
    output: "outfile",
    usage: codexJsonlUsage,
  },
  /** chatgpt.com daemon CLI (gitea chaoxu/chatgpt-cli): the only road to
   *  ChatGPT-Pro-only models. The daemon picks the actual model, so the spec's
   *  modelId is a provenance label. Emits {ok, text, error} JSON on stdout.
   *  --timeout is the oracle's poll deadline; 604800s = 7 days is a hang guard,
   *  not a work limit (user decision: no timeouts on model thinking). */
  "chatgpt-cli": {
    env: "COVERIFY_CHATGPT_CMD",
    cmd: "chatgpt-cli oracle --quiet --timeout 604800",
    output: "oracle-json",
    unmetered: true,
  },
  /** Antigravity CLI (Google subscription): the gemini ideation family.
   *  Prompt-as-argv and spaced display-name model ids are handled by the
   *  bin/agy-oracle transport wrapper ({repo} resolves to the checkout). */
  agy: { env: "COVERIFY_AGY_CMD", cmd: "{repo}/bin/agy-oracle {model}", output: "stdout", unmetered: true },
};

export function cliBackendCommand(provider: keyof typeof CLI_BACKENDS): string {
  const backend = CLI_BACKENDS[provider];
  return process.env[backend.env] ?? backend.cmd;
}

/** The same template, safe to write into a record. A built-in default is
 *  recorded verbatim (no secret, and it IS the reproducibility fact); a user
 *  override is recorded only as the fact that one exists, because these are
 *  free-form shell strings that routinely carry auth flags and the run stamp is
 *  mirrored into the in-tree journal, which is plausibly committed. */
export function cliBackendCommandForRecord(provider: keyof typeof CLI_BACKENDS): string {
  const backend = CLI_BACKENDS[provider];
  return process.env[backend.env] === undefined ? backend.cmd : `<set: ${backend.env}>`;
}

export function systemText(run: Pick<RoleRun, "contract" | "charge">): string {
  return `The campaign contract below governs this work. Follow it exactly.\n\n<contract>\n${run.contract}\n</contract>\n\n${run.charge}`;
}

/** claude -p --output-format json result payload (the fields we read). */
interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  /** Names this run's transcript under ~/.claude/projects/<encoded cwd>/. */
  session_id?: string;
  /** Per-model usage map; its key (and canonicalModel) is the CLI's own
   *  report of what answered — self-reported, not server-attested (#21 P3). */
  modelUsage?: Record<string, { canonicalModel?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Provider requests this call made. codexJsonlUsage SUMS every turn.completed,
 *  so stamping requests:1 beside a tool loop reports N turns of spend against
 *  one claimed request. Same event, counted rather than summed. */
export function codexTurns(stdout: string): number {
  let n = 0;
  for (const line of stdout.split("\n")) {
    // Parsed, not substring-matched, and gated on the SAME predicate
    // codexJsonlUsage sums on: a truncated line, a usage-less turn.completed, or
    // prose quoting the literal would otherwise count a request whose tokens
    // were never added.
    if (!line.includes('"turn.completed"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; usage?: unknown };
      if (e.type === "turn.completed" && e.usage) n++;
    } catch {}
  }
  return n;
}

/** The rollout id codex writes for this call: `codex exec --json` emits
 *  {"type":"thread.started","thread_id":...} first, and that id is verbatim the
 *  `session_id` of the rollout under ~/.codex/sessions/, which carries
 *  `rate_limits.primary.used_percent` — the meter that actually ends campaigns. */
export function codexThreadId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"thread.started"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; thread_id?: string };
      if (e.type === "thread.started" && typeof e.thread_id === "string") return e.thread_id;
    } catch {
      /* not the line we want */
    }
  }
  return undefined;
}

/**
 * Run one single-shot role through an official subscription CLI. cwd is a fresh
 * empty temp dir, so the CLI's own tools find nothing (instructed-only
 * isolation). No timeout: audit and reconstruction work is never clocked. Output
 * comes from the {out} file when the template names one, else stdout. Usage is
 * telemetry only — absence never fails the call.
 */
function runCliRole(
  provider: keyof typeof CLI_BACKENDS,
  modelId: string,
  fullPrompt: string,
  signal?: AbortSignal,
): Promise<{
  text: string;
  usage?: RoleUsage;
  servedModel?: string;
  reportedModel?: string;
  /** Rollout join keys; see codexThreadId. `backendCwd` is the per-call temp
   *  cwd, a second route to the same rollout via its session_meta.cwd. */
  providerSessionId?: string;
  backendCwd?: string;
  /** Derived from the stream (one turn.completed per request), never 1. */
  requests?: number;
}> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coverify-cli-"));
  const outFile = path.join(cwd, "last-message.txt");
  const backend = CLI_BACKENDS[provider];
  const parts = cliBackendCommand(provider)
    .replaceAll("{model}", modelId)
    .replaceAll("{repo}", repoRoot())
    .replaceAll("{out}", outFile)
    .split(/\s+/);
  return new Promise((resolve, reject) => {
    // detached: the CLI gets its own process group so kill() takes the whole
    // tree. The codex CLI is a node wrapper whose vendored binary runs as a
    // grandchild — SIGKILLing only the wrapper orphans it, still thinking and
    // billing headless (issue #19, observed on the 2026-08-08 lin3cut restart).
    const child = spawn(parts[0], parts.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    // A spawned verdict role must die when the harness dies. Without this an
    // in-flight `claude -p` audit outlives a pause, bills a full Opus run, and
    // its verdict lands nowhere.
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    installReaperHooks();
    liveReapers.add(kill);
    const onAbort = () => kill();
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      liveReapers.delete(kill);
      signal?.removeEventListener("abort", onAbort);
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    child.once("error", cleanup);
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", reject);
    child.on("close", (code: number | null, signalName: NodeJS.Signals | null) => {
      // Read {out} BEFORE reaping the temp dir: cleanup in an earlier 'close'
      // handler deleted the out file first, and every codex-cli verdict silently
      // fell back to raw --json stdout and parsed UNPARSEABLE (c60c03f).
      const outText = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf-8") : undefined;
      cleanup();
      if (backend.output === "oracle-json") {
        try {
          const payload = JSON.parse(out) as {
            ok?: boolean;
            text?: string;
            error?: string;
            served_model?: string | null;
          };
          if (code !== 0 || !payload.ok || !payload.text?.trim()) {
            return reject(new Error(`${provider} failed: ${payload.error ?? `exit ${code}`}`));
          }
          // Served-model enforcement (user policy 2026-08-09; issue #20):
          // ChatGPT's router silently downgrades, so anything but an exact match
          // to the requested model is "no useful response".
          const served = payload.served_model ?? undefined;
          if (served !== modelId) {
            return reject(
              new Error(
                `${provider}: no useful response — served model ${served ?? "unattested"} != ` +
                  `requested ${modelId}; reply discarded (router downgrade, not an answer)`,
              ),
            );
          }
          return resolve({
            text: `${payload.text.trim()}\n\n[served model: ${served} (server-attested)]`,
            servedModel: `${provider}/${served} (server-attested)`,
          });
        } catch {
          return reject(new Error(`${provider} returned non-JSON output (exit ${code}): ${err.slice(0, 300)}`));
        }
      }
      if (code !== 0) {
        // Empty stderr on a nonzero exit happened three times on 2026-08-09
        // (claude-cli exit 1, no message) while identical probes succeeded, so
        // surface whatever the process did leave.
        const detail = err.trim()
          ? err.slice(0, 500)
          : `no stderr; signal=${String(signalName)}; stdout head: ${out.slice(0, 300).trim() || "(empty)"}`;
        // The provider was paid before it failed and stdout already holds
        // turn.completed usage; rejecting before parsing discards a measured
        // number.
        const failure: BilledFailure = new Error(`${provider} exited ${code}: ${detail}`);
        const spent = backend.usage?.(out);
        if (spent) failure.usage = spent;
        failure.providerSessionId = codexThreadId(out);
        failure.backendCwd = cwd;
        failure.requests = codexTurns(out) || undefined;
        return reject(failure);
      }
      if (backend.output === "claude-json") {
        try {
          const payload = JSON.parse(out) as ClaudeJsonResult;
          if (payload.is_error) return reject(new Error(`${provider} reported an error result`));
          const u = payload.usage;
          // Self-reported model (#21 P3): journal it beside the requested spec,
          // NEVER refuse on mismatch — that would invent policy (rule 3).
          const mu = payload.modelUsage ?? {};
          const reportedKey = Object.keys(mu)[0];
          const reported = reportedKey ? (mu[reportedKey].canonicalModel ?? reportedKey) : undefined;
          return resolve({
            text: (payload.result ?? "").trim(),
            reportedModel: reported ? `${provider}/${reported}` : undefined,
            // This lane also leaves a transcript at
            // ~/.claude/projects/<url-encoded cwd>/<session_id>.jsonl, holding
            // the thinking blocks the result JSON omits. Token counts stay from
            // the payload: the transcript's output_tokens is a mid-stream
            // snapshot (anthropics/claude-code #27361) and must not be summed.
            providerSessionId: payload.session_id,
            backendCwd: cwd,
            // This lane genuinely measures cache creation, unlike codex and
            // pi; observed per record rather than assumed. `reasoning` stays
            // absent: the result JSON has no thinking-token field at all
            // (absent ≠ zero; see RoleUsage).
            usage: u && claudeJsonUsage(u),
          });
        } catch {
          // Env-overridden template without --output-format json: plain text.
          return resolve({ text: out.trim(), backendCwd: cwd });
        }
      }
      if (backend.output === "outfile" && outText !== undefined) {
        return resolve({
          text: outText.trim(),
          usage: backend.usage?.(out),
          providerSessionId: codexThreadId(out),
          backendCwd: cwd,
          // Undefined when the stream said nothing: a call that happened is
          // never 0 requests, so the session falls back to its floor of 1.
          requests: codexTurns(out) || undefined,
        });
      }
      resolve({ text: out.trim() });
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}
