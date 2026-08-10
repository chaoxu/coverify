// Subscription CLI transports: the spawned official-CLI lane behind the
// single-shot verdict roles (claude, codex, chatgpt-cli, agy) — command
// templates, process-group kill/reaper wiring, and output/usage parsing.
// Semantics-invisible mechanics (design rule 2) with one exception: the
// served-model attestation policy on the oracle-json path (user policy,
// Chao 2026-08-09; issue #20) lives here because it is a property of the
// transport's reply, enforced at the only point the reply is parsed.
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { repoRoot } from "./campaign.js";
import { installReaperHooks, liveReapers } from "./sandbox.js";
import type { RoleRun, RoleSession, RoleUsage } from "./providers.js";

/** A CLI failure that still cost money: the provider was paid before it exited
 *  nonzero, so the rejection carries the spend and its join keys instead of
 *  discarding them. One shape for the writer here and the reader in cadence.ts,
 *  so a leafed failure can't quietly drop a field neither side names. */
export interface BilledFailure extends Error {
  usage?: RoleUsage;
  providerSessionId?: string;
  backendCwd?: string;
}

/**
 * A spawned official CLI as a degenerate RoleSession: it answers exactly
 * once, can be stopped (kill) but not steered, holds no transcript, and
 * reports usage only when its machine-readable output carried it. The
 * capability flags make the honesty-ledger claim ("a CLI role can be
 * stopped but not steered") observable in the type instead of inferred
 * from a missing field.
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
      const r = await runCliRole(provider, run.spec.modelId, fullPrompt, stop.signal);
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
    // Server-attested served model (oracle backends only): the honest value
    // for a record's modelFamily — the requested spec is testimony, this is
    // attestation (issue #20).
    servedModel: () => servedModel,
    /** Self-reported model (claude-cli). Journal-only: recorded beside the
     *  requested spec, never enforced (#21 P3). codex-cli emits no model
     *  echo in its JSONL (verified 2026-08-09), so it stays undefined. */
    reportedModel: () => reportedModel,
    unmetered: () =>
      CLI_BACKENDS[provider].unmetered && asked
        ? [{ lane: provider, detail: `${provider} reports no usage payload` }]
        : [],
    // A CLI oracle answers exactly once and keeps no transcript, so attempts
    // is exact. Requests is NOT: a codex tool loop is several requests inside
    // that one answer, so the count derived from the stream wins wherever the
    // transport could produce one (runCliRole's `requests`).
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
  /** This lane reports no usage at all. Not "reported zero" — no payload
   *  exists — so a record must carry the gap explicitly. */
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
    // cross-family check behind every promotion — "otherwise it's hard to
    // believe the result". The codex verdict roles already run max-tier
    // reasoning (user's ~/.codex config: model_reasoning_effort ultra), so
    // this closes the last default-effort gap in the cadence. Audits are
    // ~1% of token spend; several-fold deeper thinking stays negligible.
    cmd: "claude -p --model {model} --effort max --output-format json",
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
  /** --timeout here is the oracle's poll deadline; 604800s = 7 days — a hang
   *  guard, not a work limit (user decision: no timeouts on model thinking,
   *  Chao 2026-08-09). */
  "chatgpt-cli": {
    env: "COVERIFY_CHATGPT_CMD",
    cmd: "chatgpt-cli oracle --quiet --timeout 604800",
    output: "oracle-json",
    // The daemon's reply carries no usage payload, so calls on this lane are
    // real spend this harness cannot measure. Declared here so the record
    // says "unmetered" rather than simply omitting a number.
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

/** Sum token usage from codex --json JSONL events ({type:"turn.completed"}). */
function codexJsonlUsage(stdout: string): RoleUsage | undefined {
  let found = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawCacheWrite = false;
  // Absent unless an event actually carried it — a measured 0 and "the field
  // was never reported" are different records.
  let reasoning: number | undefined;
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
    // `input` is the UNCACHED part, disjoint from cacheRead/cacheWrite — the
    // convention the pi lane already records and that view/turns.ts documents.
    // Codex nests them: input_tokens includes cached_input_tokens and
    // cache_write_input_tokens (verified over 50,152 records — none has cached
    // > input, and total_tokens == input + output throughout). Copying
    // input_tokens through unsubtracted made this lane's records mean something
    // different from every other lane's, and overstated fresh input by 30% in
    // the 2026-08-09 cost study before anyone noticed. Journals written before
    // this fix carry the nested convention for gate-critic, certifier,
    // reconstructor and comparator; see docs/measurement-protocol.md rule 1.
    const cr = event.usage.cached_input_tokens ?? 0;
    const cw = event.usage.cache_write_input_tokens ?? 0;
    if (event.usage.cache_write_input_tokens !== undefined) sawCacheWrite = true;
    input += Math.max(0, (event.usage.input_tokens ?? 0) - cr - cw);
    output += event.usage.output_tokens ?? 0;
    cacheRead += cr;
    cacheWrite += cw;
    if (event.usage.reasoning_output_tokens !== undefined)
      reasoning = (reasoning ?? 0) + event.usage.reasoning_output_tokens;
  }
  return found
    ? {
        input, output, cacheRead, reasoning, meter: "codex-cli-jsonl" as const,
        // Observed per record, never read off a lane table: the day codex
        // #32479 lands and the field starts arriving, this records the real
        // number instead of stamping a stale "unmeasured" over it.
        ...(sawCacheWrite ? { cacheWrite } : {}),
      }
    : undefined;
}

/** Provider requests this call made. codexJsonlUsage SUMS every
 *  turn.completed, so a tool loop records N turns of tokens; stamping
 *  requests:1 beside that would report four turns of spend against one
 *  claimed request. Same event, counted rather than summed. */
export function codexTurns(stdout: string): number {
  let n = 0;
  for (const line of stdout.split("\n")) if (line.includes('"turn.completed"')) n++;
  return n;
}

/** The rollout id codex writes for this call. `codex exec --json` emits
 *  {"type":"thread.started","thread_id":...} as its first line, and that id is
 *  verbatim the `session_id` of the rollout under ~/.codex/sessions/ — which
 *  carries `rate_limits.primary.used_percent`, the meter that actually ends
 *  campaigns and that nothing in this journal could previously join to. */
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
  signal?: AbortSignal,
): Promise<{
  text: string;
  usage?: RoleUsage;
  servedModel?: string;
  reportedModel?: string;
  /** Rollout join keys; see codexThreadId. `backendCwd` is the per-call temp
   *  cwd, a second route to the same rollout via its session_meta.cwd that
   *  holds when stdout was lost or the event name changes upstream. */
  providerSessionId?: string;
  backendCwd?: string;
  /** Provider requests this call made — a codex tool loop emits one
   *  turn.completed per request, so it is derived, never assumed to be 1. */
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
    // detached: the CLI gets its own process group so kill() can take the
    // whole tree. The codex CLI is a node wrapper whose vendored binary runs
    // as a grandchild — SIGKILLing only the wrapper orphans the binary, which
    // keeps thinking (and billing) headless. That is exactly the issue-#19
    // survivor observed on the 2026-08-08 lin3cut restart.
    const child = spawn(parts[0], parts.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    // A spawned verdict role is work like any other: it must die when the
    // harness dies, and stop when the campaign stops. Without this an
    // in-flight `claude -p` audit outlives a pause, bills a full Opus run,
    // and its verdict lands nowhere because no live process is waiting.
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
      // Read {out} BEFORE reaping the temp dir. Cleanup used to run as its
      // own earlier 'close' handler, deleting the out file before this
      // resolver's existsSync — every codex-cli verdict silently fell back
      // to raw --json stdout and parsed UNPARSEABLE (regression from
      // c60c03f, caught by the 2026-08-07 smoke campaign, the first live
      // run after that commit).
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
          // Served-model enforcement (user policy, Chao 2026-08-09; issue
          // #20): ChatGPT's router silently downgrades, and a weak model's
          // advice must never enter the campaign wearing a Pro label. The
          // oracle reports the server-attested resolved slug; anything but
          // an exact match to the requested model is "no useful response".
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
        // Empty stderr on a nonzero exit is uninformative and happened three
        // times on 2026-08-09 (claude-cli exit 1, no message) while identical
        // probes succeeded — so surface whatever the process DID leave:
        // stdout head and the signal, and say plainly that the CLI reported
        // nothing. Without this the next occurrence is equally unreadable.
        const detail = err.trim()
          ? err.slice(0, 500)
          : `no stderr; signal=${String(signalName)}; stdout head: ${out.slice(0, 300).trim() || "(empty)"}`;
        // The provider was paid before it failed — for codex, stdout already
        // holds turn.completed usage. Rejecting before parsing threw away a
        // measured number, which is the one thing this journal must not do.
        const failure: BilledFailure = new Error(`${provider} exited ${code}: ${detail}`);
        const spent = backend.usage?.(out);
        if (spent) failure.usage = spent;
        failure.providerSessionId = codexThreadId(out);
        failure.backendCwd = cwd;
        return reject(failure);
      }
      if (backend.output === "claude-json") {
        try {
          const payload = JSON.parse(out) as ClaudeJsonResult;
          if (payload.is_error) return reject(new Error(`${provider} reported an error result`));
          const u = payload.usage;
          // Self-reported model (#21 P3): journal it beside the requested
          // spec, NEVER refuse on mismatch — auto-refusing would invent
          // policy (design rule 3). Highest-value case is the hostile
          // auditor's cross-family guarantee.
          const mu = payload.modelUsage ?? {};
          const reportedKey = Object.keys(mu)[0];
          const reported = reportedKey ? (mu[reportedKey].canonicalModel ?? reportedKey) : undefined;
          return resolve({
            text: (payload.result ?? "").trim(),
            reportedModel: reported ? `${provider}/${reported}` : undefined,
            // This lane leaves a transcript too, under
            // ~/.claude/projects/<url-encoded cwd>/<session_id>.jsonl —
            // verified: 411 such directories exist from past auditor runs,
            // named after the mkdtemp cwd. It holds the THINKING BLOCKS this
            // lane's result JSON omits, so "reasoning is a provider fact we
            // cannot have" was only true of the payload, not of the run.
            // Token counts stay from the payload: the transcript's
            // output_tokens is a mid-stream snapshot (anthropics/claude-code
            // #27361), so it must not be summed.
            providerSessionId: payload.session_id,
            backendCwd: cwd,
            usage: u && {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              // This lane genuinely measures cache creation, unlike the codex
              // and pi lanes; observed per record rather than assumed.
              ...(u.cache_creation_input_tokens !== undefined
                ? { cacheWrite: u.cache_creation_input_tokens }
                : {}),
              meter: "claude-cli-json" as const,
              // `reasoning` stays absent: the result JSON has no thinking-token
              // field at all (absent on 204/204 audit records). pi's contract
              // already fixes undefined as "provider does not report it", so no
              // parallel gap list is needed.
            },
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
          // Provider requests in this call: codex runs a tool loop and emits
          // one turn.completed per request, so this is derived from the
          // stream rather than assumed to be 1. Undefined when the stream said
          // nothing — a call that happened is never 0 requests, so the session
          // falls back to its floor of 1 rather than reporting "no call".
          requests: codexTurns(out) || undefined,
        });
      }
      resolve({ text: out.trim() });
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}
