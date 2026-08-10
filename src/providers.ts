// Model providers and role invocation: pi-ai provider registry, per-role
// model specs, runRole, harness role sessions, and usage accounting (the
// subscription CLI transports live in backends.ts). Semantics-invisible
// mechanics (design rule 2): how a model gets called, never what it is told
// (charges live in roles.ts).
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  AgentHarness,
  InMemorySessionRepo,
  JsonlSessionRepo,
  estimateContextTokens,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  createModels,
  isContextOverflow,
  retryAssistantCall,
  type AssistantMessage,
  type Transport,
  type Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { cliBackendCommand, createCliRoleSession, isCliProvider, systemText } from "./backends.js";
import { repoRoot } from "./campaign.js";
import { fileCredentialStore } from "./credentials.js";
import { CLAUDE_BRIDGE_ID, claudeBridgeProvider } from "./claude-bridge.js";
import { envNumber, type WriteScope } from "./sandbox.js";
import { workspaceTools } from "./workspace.js";

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

const PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "google",
  CLAUDE_BRIDGE_ID,
  "claude-cli",
  "codex-cli",
  "chatgpt-cli",
  "agy",
] as const;

export interface ModelSpec {
  provider: (typeof PROVIDERS)[number];
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

/** One resolver for every env-overridable spec: role defaults and ideation
 *  families are the same mechanism (user-recorded default, env override). */
const envSpec = (env: string, fallback: string): ModelSpec =>
  parseModelSpec(process.env[env] ?? fallback);

/** Is this provider usable right now — CLI binary on PATH, or an API/OAuth
 *  credential the models registry resolves? One answer for the prove()
 *  preflight and dispatch-time family checks; they must never disagree. */
export async function providerUsable(models: Models, provider: ModelSpec["provider"]): Promise<boolean> {
  if (isCliProvider(provider)) {
    const { spawnSync } = await import("node:child_process");
    // Substitute template placeholders BEFORE probing: the agy backend's
    // command starts with "{repo}/bin/agy-oracle", and `which "{repo}/..."`
    // refused every gemini dispatch on the first live night (10/10) while
    // the wrapper worked fine — audit finding, 2026-08-09.
    const head = cliBackendCommand(provider).replaceAll("{repo}", repoRoot()).split(/\s+/)[0];
    return (head.startsWith("/") ? fs.existsSync(head) : spawnSync("which", [head]).status === 0);
  }
  try {
    return (await models.getAuth(provider)) !== undefined;
  } catch {
    return false;
  }
}

/** Spec format: `provider/model[@thinking]`; bare model id means anthropic. */
function parseModelSpec(spec: string): ModelSpec {
  const [modelPart, thinking = "high"] = spec.split("@");
  const slash = modelPart.indexOf("/");
  const provider = slash < 0 ? "anthropic" : modelPart.slice(0, slash);
  const modelId = slash < 0 ? modelPart : modelPart.slice(slash + 1);
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `unknown provider "${provider}" in model spec "${spec}" (valid: ${PROVIDERS.join(", ")})`,
    );
  }
  return { provider: provider as ModelSpec["provider"], modelId, thinking: thinking as ThinkingLevel };
}

/** Resolution: COVERIFY_MODEL_<ROLE> > role default (every role has one). */
export function roleModelSpec(role: RoleName): ModelSpec {
  return envSpec(ROLE_ENV[role], ROLE_DEFAULTS[role]);
}

/** Ideation families (user decision, Chao 2026-08-09): a reasoner dispatch
 *  may carry family:"fable"|"gemini" to run that one worker on a different
 *  model family — decorrelated proposal streams through the same charge and
 *  the same gates (Danus study: same-family swarms added no new ideas; the
 *  different-family consult carried the plan). Model routing is harness
 *  mechanics (design rule 2); specs overridable via COVERIFY_FAMILY_<NAME>. */
// Family -> default spec; env override is derived (COVERIFY_FAMILY_<NAME>).
// Subscription-billed CLIs, not metered APIs (same policy as the role
// defaults): fable through the official Claude CLI (Max), gemini through
// agy (Google), and "pro" — the Danus-style advisor lane — through the
// chatgpt-cli oracle. All three are single-shot toolless consults (the
// packet must inline everything). For "pro", served-model attestation is
// enforced at the oracle parse: a router-downgraded reply is discarded as
// "no useful response" (user policy, Chao 2026-08-09), so weak-model advice
// cannot enter the campaign wearing a Pro label.
const FAMILY_SPECS: Record<string, string> = {
  // Repointed to Opus 2026-08-09 (user decision: Fable quota exhausted;
  // "let's switch to opus for ideas"). The family name stays "fable" as the
  // Anthropic-lane label coordinators already know; dispatch records stamp
  // the resolved model, so provenance is exact either way.
  fable: "claude-cli/opus",
  gemini: "agy/gemini-3.1-pro-high",
  pro: "chatgpt-cli/gpt-5-6-pro",
};
export const IDEATION_FAMILIES = Object.keys(FAMILY_SPECS);
export function familyModelSpec(family: string): ModelSpec | undefined {
  const fallback = FAMILY_SPECS[family];
  return fallback === undefined
    ? undefined
    : envSpec(`COVERIFY_FAMILY_${family.toUpperCase()}`, fallback);
}

/** Resolve an ideation-family request to a usable spec, or a refusal reason
 *  the coordinator can act on in the same turn. Owns the model policy so the
 *  harness keeps only the refuse() wiring. */
export async function resolveFamily(
  models: Models,
  family: string,
): Promise<{ spec: ModelSpec } | { reason: string }> {
  const spec = familyModelSpec(family);
  if (spec === undefined) {
    return {
      reason:
        `unknown ideation family "${family}" (available: ${IDEATION_FAMILIES.join(", ")}); ` +
        "omit the field for the default model",
    };
  }
  if (!(await providerUsable(models, spec.provider))) {
    return {
      reason:
        `ideation family "${family}" (${specLabel(spec)}) has no usable auth on this host — ` +
        "redispatch without the family field (the packet is otherwise fine)",
    };
  }
  return { spec };
}

export function specLabel(spec: ModelSpec): string {
  return `${spec.provider}/${spec.modelId}`;
}

/** A spec including its thinking level. Journalled per role in the run-config
 *  stamp and per usage event; the two must be spelled identically, because
 *  that string is the join between them. */
export function specKey(spec: ModelSpec): string {
  return `${specLabel(spec)}@${spec.thinking}`;
}

function getModel(models: Models, spec: ModelSpec) {
  const model = models.getModel(spec.provider, spec.modelId);
  if (!model) {
    throw new Error(
      `unknown ${spec.provider} model id "${spec.modelId}"; check the COVERIFY_MODEL* spec ` +
        `(auth: ${{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", "openai-codex": "coverify login openai-codex", "claude-bridge": "claude binary (Claude Code login)", "claude-cli": "claude binary", "codex-cli": "codex binary", "chatgpt-cli": "chatgpt-cli binary (daemon must be running)", agy: "agy binary (Antigravity login)" }[spec.provider]})`,
    );
  }
  return model;
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
 * critic, hostile auditor, bundle certifier, reconstructor, comparator):
 * an in-memory harness session on API providers, an official CLI otherwise —
 * toolless either way. The coordinator and dispatched agents run as durable
 * sessions via createHarnessRoleSession (harness.ts). What each
 * instance sees is decided by the bundle its caller builds; the journal
 * records supplied inputs and which restrictions are platform-enforced
 * versus instructed.
 */
export async function runRole(
  run: Omit<RoleRun, "workspace" | "extraTools">,
  signal?: AbortSignal,
): Promise<RoleResult> {
  const started = Date.now();
  // One invocation surface: every role call is a session asked once. A CLI
  // backend is a degenerate session (answers once, stoppable, not
  // steerable); an API provider gets an in-memory harness session with a
  // stable per-call prompt-cache key (pi derives prompt_cache_key from the
  // session id — ~80% prefix-cache hit measured, see f0ad016).
  const cli = isCliProvider(run.spec.provider) ? createCliRoleSession(run, signal) : undefined;
  const session = cli ?? (await createHarnessRoleSession(run, { sessionId: randomUUID(), ephemeral: true }));
  const text = await session.ask(run.prompt);
  return {
    text,
    usage: session.usage(),
    servedModel: cli?.servedModel?.(),
    reportedModel: cli?.reportedModel?.(),
    providerSessionId: cli?.providerSessionId?.(),
    backendCwd: cli?.backendCwd?.(),
    attempts: session.attempts?.(),
    requests: session.requests?.(),
    // promptChars counts what actually went over the wire: the CLI path
    // inlines the contract+charge into one prompt string.
    promptChars: cli ? cli.promptChars() : run.prompt.length,
    durationMs: Date.now() - started,
  };
}

export interface RoleSession {
  /** What this substrate can actually do, stated explicitly rather than
   *  inferred from which fields exist: a spawned CLI answers once and can be
   *  stopped but not steered (the honesty ledger's claim, kept observable);
   *  a harness session is steerable, and durable when its transcript
   *  persists. */
  readonly capabilities: { steerable: boolean; durable: boolean };
  ask(prompt: string): Promise<string>;
  /** Context size in tokens from pi's estimator over the session's context messages. */
  approxTokens(): number;
  /** Cumulative provider-reported token usage across the session's calls;
   *  undefined when the backend reported none (never fabricated zeros). */
  usage(): RoleUsage | undefined;
  /** Server-attested served model, when the backend reports one (oracle
   *  backends only; issue #20). Undefined everywhere else — never an echo. */
  servedModel?(): string | undefined;
  /** Self-reported model, when the backend states one (#21 P3). */
  reportedModel?(): string | undefined;
  /** Provider calls this session made whose tokens cannot be measured — an
   *  external agent with no machine-readable usage. Real spend, recorded as a
   *  gap so it never reads as costing nothing. */
  unmetered?(): { lane: string; detail: string }[];
  /** Provider attempts made by this session, retries included. A retry
   *  re-presents the whole context and is billed again but leaves no message,
   *  so this is the one part of request-level cost that cannot be recovered
   *  from a transcript afterwards. */
  attempts?(): number;
  /** Provider requests that produced output. Derived from the transcript where
   *  one exists, so it never becomes a second source that can drift. */
  requests?(): number;
  /** Join keys into the provider's own transcript, where telemetry this
   *  harness cannot see otherwise lives — for the codex lane, the rollout
   *  under ~/.codex/sessions/ carrying rate_limits.primary.used_percent.
   *  Recorded so the account's window trajectory becomes joinable; that
   *  series is account-wide, never coverify-attributable consumption. */
  providerSessionId?(): string | undefined;
  /** Second route to the same transcript when the id is unavailable. */
  backendCwd?(): string | undefined;
  /** In-place lossy compaction (harness-backed sessions only): summarize
   *  older turns, keep a recent tail verbatim. The caller owns the policy
   *  and the contract's post-compaction reread rule. */
  compact?(customInstructions?: string): Promise<void>;
  /** Inject a steering message while the session is running. Resolves true
   *  iff the session accepted it (false: session idle, message dropped). */
  steer(text: string): Promise<boolean>;
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


/** Which parser produced a usage record. NOT a convention discriminator —
 *  all three normalize `input` to the uncached part (pi and codex-cli both
 *  subtract cached and cache-write; Anthropic reports it exclusive natively).
 *  It is provenance: which adapter to go fix when a number looks wrong. */
export type Meter = "pi-session" | "codex-cli-jsonl" | "claude-cli-json";

/** Coverify's usage record: pi's `Usage` contract minus what only pi can
 *  compute, plus provenance. Derived from pi's type rather than paralleling
 *  it — view/turns.ts parses pi's own session JSONL as a RoleUsage, so the
 *  two were already structurally coupled across a package boundary, with a pi
 *  upgrade as the silent failure trigger.
 *
 *  From pi's contract, and the reason two fields are optional:
 *  - `reasoning` is a SUBSET of `output` (output already includes it), left
 *    undefined by providers that expose no breakdown. Adding it to output
 *    double-counts.
 *  - `cacheWrite` is optional HERE though required in pi's type: absence means
 *    the provider never reported it, which is different from a measured zero.
 *    Both the pi and codex-cli lanes hit this — cache_write_input_tokens is
 *    absent upstream (codex #32479, pi #6469), so a 0 there is a broken meter,
 *    not a measurement. Absence carries that, so no parallel gap-list is
 *    needed.
 *  `cacheWrite1h` is omitted rather than inherited: no lane sets it and neither
 *  combinator carries it, and a type that advertises a field addUsage silently
 *  drops is how a sum starts losing tokens on the next pi upgrade. */
export type RoleUsage = Omit<PiUsage, "cost" | "totalTokens" | "cacheWrite" | "cacheWrite1h"> & {
  cacheWrite?: number;
  /** Which adapter produced this record — provenance, not convention (see
   *  Meter). Absent on records written before 2026-08-09. */
  meter?: Meter;
  /** No dollar field, deliberately. Every role runs on a subscription lane
   *  (see ROLE_DEFAULTS), so every price a provider reports — pi's per-message
   *  cost, the claude CLI's `total_cost_usd` — is notional list price, not
   *  money spent. Tokens and the model identity (recorded per dispatch as
   *  `modelFamily`) are the facts; a reader wanting dollars applies a rate
   *  table at read time, where "these are list prices" is an explicit
   *  assumption rather than a field name that quietly asserts otherwise. */
};

/** Field-wise RoleUsage sum (reduce-friendly). An optional field stays absent
 *  unless some addend reported it: a measured 0 and "no backend reported this"
 *  are different records, and coercing the second into the first is how this
 *  journal used to claim things it did not know. */
export function addUsage(a: RoleUsage, b: RoleUsage): RoleUsage {
  const reported = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  // Deliberately TOTAL: this runs inside persist()'s store.append argument on
  // the settle path, where a throw would skip the completion record, orphan a
  // report already on disk, and reject handle.settled — whose contract is
  // "resolves, never rejects" — taking the whole campaign down with every live
  // agent's work unharvested. Observability may not end a campaign (rule 2).
  const sum: RoleUsage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: reported(a.cacheWrite, b.cacheWrite),
    reasoning: reported(a.reasoning, b.reasoning),
  };
  // Provenance survives only when both addends agree. Summing a stamped record
  // with an unstamped one (a pre-2026-08-09 line, or usage rebuilt from pi's
  // session JSONL) leaves it absent: "unknown" is the truth, and asserting the
  // known one would be the guessing this field exists to stop.
  if (a.meter !== undefined && a.meter === b.meter) sum.meter = a.meter;
  return sum;
}

/** `a - b`, field-wise, for turning a cumulative session total into the leaf
 *  each wake actually spent. Optional fields follow the same absent-vs-zero
 *  rule as addUsage: a field neither side reported stays absent. Clamped at
 *  zero — a session total is monotone (usage() sums every message ever plus
 *  compaction), so a negative would mean the baseline came from another
 *  session, and recording a negative token count would poison every sum
 *  downstream. */
export function subUsage(a: RoleUsage, b?: RoleUsage): RoleUsage & { nonMonotone?: true } {
  // Copy, never alias: the caller keeps `a` as the next baseline while this
  // result is journalled, and a shared object would couple the two.
  if (b === undefined) return { ...a };
  let clamped = false;
  const clamp = (x: number) => {
    if (x >= 0) return x;
    clamped = true;
    return 0;
  };
  // An absent minuend stays absent: subtracting from "the provider never
  // reported this" must not manufacture a measured zero.
  const less = (x?: number, y?: number) => (x === undefined ? undefined : clamp(x - (y ?? 0)));
  const d: RoleUsage & { nonMonotone?: true } = {
    input: clamp(a.input - b.input),
    output: clamp(a.output - b.output),
    cacheRead: clamp(a.cacheRead - b.cacheRead),
    cacheWrite: less(a.cacheWrite, b.cacheWrite),
    reasoning: less(a.reasoning, b.reasoning),
  };
  if (a.meter !== undefined) d.meter = a.meter;
  // The clamp is the last line of defence, not a silent correction: a session
  // total is monotone today, and if that ever stops being true real spend
  // vanishes into a Math.max. Absence must be observable — mark it.
  if (clamped) d.nonMonotone = true;
  return d;
}

/** The one accumulation rule for pi-lane usage. Exported because view/turns.ts
 *  rebuilds the same totals from pi's own session JSONL, and the agreement
 *  between the two is the 2026-08-09 study's only genuine cross-check — journal
 *  peaks against session trees agreed to 0.2%, and the one place they disagreed
 *  (41% on fresh input) located a real defect. Two hand-synced copies of this
 *  rule would have made that check a comparison of one rule against a stale
 *  fork of itself (issue #43). A view may import from core; core may not import
 *  from a view (scripts/conformance-check.ts). */
export function sumMessagesUsage(messages: readonly unknown[]): RoleUsage {
  const total: RoleUsage = { input: 0, output: 0, cacheRead: 0, meter: "pi-session" };
  // cacheWrite is deliberately NOT initialised: pi's type requires the field
  // and always emits 0, but cache_write_input_tokens is absent upstream
  // (pi #6469 / codex #32479), so that 0 is a broken meter rather than a
  // measurement. Leaving it absent lets the record say "unknown". Delete this
  // guard the day upstream reports it — this list is provider bugs, not
  // schema.
  for (const m of messages) {
    const msg = m as { role?: string; usage?: RoleUsage };
    if (msg.role !== "assistant" || !msg.usage) continue;
    const u = msg.usage;
    total.input += u.input ?? 0;
    total.output += u.output ?? 0;
    total.cacheRead += u.cacheRead ?? 0;
    if (u.cacheWrite) total.cacheWrite = (total.cacheWrite ?? 0) + u.cacheWrite;
    if (u.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + u.reasoning;
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
  /** Server-attested served model (oracle backends): when present, records
   *  must prefer it over the requested spec label (issue #20 — the spec is
   *  testimony, this is attestation). */
  servedModel?: string;
  /** Self-reported model (claude-cli's own JSON). Journalled beside the
   *  requested spec; never enforced (#21 P3, rule 3). */
  reportedModel?: string;
  /** Provider-side transcript join keys (codex lane); see RoleSession. */
  providerSessionId?: string;
  backendCwd?: string;
  /** Request-level counts: the last edge of the record tree. Without these a
   *  record spanning a tool loop cannot be told from one spanning retries. */
  attempts?: number;
  requests?: number;
}

export type HarnessSessionOpts = {
  /** Stable session identity: names the session and becomes the
   *  provider's prompt_cache_key (keep ≤64 chars). */
  sessionId: string;
} & (
  | {
      /** Directory for durable session trees (e.g. <campaign>/.coverify/sessions). */
      sessionsRoot: string;
      cwd: string;
      ephemeral?: false;
    }
  /** In-memory session (single-shot roles): same harness surface and cache
   *  keying, nothing written under .coverify/sessions/. */
  | { ephemeral: true }
);

/**
 * Role session on pi's AgentHarness (redesign phase 1), implementing the full
 * RoleSession surface (telemetry, compaction, steering). By default the
 * transcript is an append-only JSONL session tree on disk —
 * crash-survivable, forkable, and the raw material for telemetry; with
 * `ephemeral: true` (runRole's single-shot path) the same harness runs over
 * an in-memory repo and leaves nothing on disk. Chosen over pi-coding-agent's
 * createAgentSession because the harness layer takes systemPrompt verbatim
 * (prompt purity by construction), our Models instance directly, and plain
 * AgentTools, with zero disk/env discovery (docs/redesign-proposal.md).
 * prompt_cache_key threads automatically from the session id.
 */
/** Turn-level retry policy for harness sessions, read at call time
 *  (min 0: zero is meaningful — it disables retries). */
export function retryPolicy(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
  const maxRetries = envNumber(process.env.COVERIFY_RETRY_MAX, 3, 0);
  return { enabled: maxRetries > 0, maxRetries, baseDelayMs: envNumber(process.env.COVERIFY_RETRY_BASE_MS, 2_000, 0) };
}

/** Stream transport for harness sessions, read at call time. Shared with the
 *  run-config stamp so the recorded policy cannot drift from the enforced one. */
export function codexTransport(): Transport {
  return (process.env.COVERIFY_CODEX_TRANSPORT as Transport | undefined) ?? "auto";
}

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
        onUnmetered: (lane, detail) => unmetered.push({ lane, detail }),
      })
    : [];
  if (run.extraTools) tools.push(...run.extraTools);
  const session = opts.ephemeral
    ? await new InMemorySessionRepo().create({ id: opts.sessionId })
    : await new JsonlSessionRepo({
        fs: new NodeExecutionEnv({ cwd: opts.cwd }),
        sessionsRoot: opts.sessionsRoot,
      }).create({ cwd: opts.cwd, id: opts.sessionId });
  const harness = new AgentHarness({
    session,
    models: run.models,
    model: getModel(run.models, run.spec),
    thinkingLevel: run.spec.thinking,
    // Stream transport (openai-codex honors it; others ignore it). "auto"
    // holds a WebSocket open for the whole turn — a Sol@max worker thinks
    // quietly for 10-20 min on one socket, and 2026-08-08 measured ~25% of
    // long turns dying mid-stream with close code 1006, each an unrecoverable
    // infra failure (pi's SSE fallback arms only for the session's NEXT turn,
    // which an ask-once worker never has). "sse" streams over plain HTTP with
    // no long-lived socket; the websocket context cache mostly benefits
    // multi-turn sessions, not ask-once workers. Env read at call time.
    streamOptions: {
      transport: codexTransport(),
    },
    // NOTE (verified 0.83.0): AgentHarness consumes this option ONLY for
    // compaction and branch-summary calls — the prompt path never reads it
    // (a live 1006 sailed through with this set; caught 2026-08-08). Kept
    // for those two call sites; ordinary turns are retried by the
    // retryAssistantCall wrapper around harness.prompt in ask() below.
    retry: retryPolicy(),
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
  // Empty total from the same builder the refresh uses: a literal here fabricated
  // `cacheWrite: 0` (a measured zero this lane never measures) and carried no
  // meter, which made addUsage drop the provenance of any usage() read before the
  // first refresh.
  let compactionUsage: RoleUsage = sumMessagesUsage([]);
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
  // Provider attempts across this session's life, retries included.
  let attempts = 0;
  // Calls this session made through tools whose spend cannot be measured.
  const unmetered: { lane: string; detail: string }[] = [];
  // Cancellation must also cover the retry wrapper's backoff sleeps:
  // harness.abort() only aborts an in-flight prompt, and between attempts
  // there is none — so abort() additionally fires this controller, which
  // retryAssistantCall honors as terminal (an aborted backoff resolves as
  // an aborted message, never another attempt).
  const sessionStop = new AbortController();
  return {
    capabilities: { steerable: true, durable: !opts.ephemeral },
    async ask(prompt: string): Promise<string> {
      // Turn-level retry at the ask boundary, built from pi's own parts:
      // retryAssistantCall classifies the resolved message — transient
      // transport/provider failures ("socket connection was closed",
      // "WebSocket closed 1006", codex fetch resets) restart the turn with
      // exponential backoff; quota/billing errors and aborts stay
      // fail-fast. 2026-08-08 measured ~30% of long Sol worker turns dying
      // to such drops on both transports; each retry re-prompts the session
      // (the failed turn stays in the transcript, like the salvage nudge),
      // and refresh() runs per attempt so telemetry counts every attempt.
      const final = await retryAssistantCall(
        async () => {
          // Each entry here is one provider attempt. A retry re-presents the
          // entire context and is billed again, but leaves no message behind —
          // so unlike request count, this is NOT derivable from the transcript
          // afterwards, and a 500k-token turn is indistinguishable from three
          // 170k attempts without it. The last missing edge of the record tree
          // (docs/measurement-protocol.md rule 13).
          attempts++;
          try {
            return (await harness.prompt(prompt)) as AssistantMessage;
          } finally {
            // Telemetry must reflect spend even when the run rejects — a
            // failed 500k-token run recorded as zero usage is worse than
            // the failure.
            await refresh().catch(() => {});
          }
        },
        retryPolicy(),
        sessionStop.signal,
      );
      // The harness resolves failures as a synthetic message; surface the
      // real cause instead of an empty string (which would read as the
      // empty-report infra failure and trigger a pointless salvage nudge).
      if (final.stopReason === "error") {
        // Classify overflow with pi's own predicate while the structured
        // message still exists (issue #24) — the appended marker is what the
        // harness diagnosis keys on, independent of provider phrasing.
        const overflow = isContextOverflow(final) ? " [context window exceeded]" : "";
        const err = new Error((final.errorMessage ?? "provider error (no message)") + overflow);
        // Salvage: pi's errored message IS the object that accumulated the
        // stream, so a turn that dies at minute 29 of 30 still holds every
        // block it received. Throwing it away loses real reasoning — BET
        // measured a 50% failure rate on ~30-minute turns, each a total
        // loss. Attach it; the harness persists it as PARTIAL evidence and
        // the completion stays a failure (never a deliverable, never a
        // verdict — verdict roles run through the CLI path, not here).
        const partial = (Array.isArray(final.content) ? final.content : [])
          .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (partial.length > 0) Object.assign(err, { partialText: partial });
        throw err;
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
    attempts: () => attempts,
    unmetered: () => unmetered,
    // Assistant messages are the provider requests that produced output; the
    // transcript already holds them, so this is derived rather than counted
    // twice — a stamped duplicate of derivable state is a second source that
    // can drift from the first.
    requests: () => allMessages.filter((m) => (m as { role?: string }).role === "assistant").length,
    async compact(customInstructions?: string): Promise<void> {
      // A real provider call with its own retry policy, and its tokens are
      // already inside usage() — so not counting it here made usage and
      // attempts disagree by construction on every compacted session.
      attempts++;
      await harness.compact(customInstructions);
      await refresh();
    },
    steer(text: string): Promise<boolean> {
      // AgentHarness.steer REJECTS when idle (worker just finished): a
      // dropped steer is routine, an unhandled rejection kills the process —
      // resolve to a delivered/dropped boolean so callers can act on it.
      return harness.steer(text).then(
        () => true,
        () => false,
      );
    },
    abort(): void {
      sessionStop.abort();
      harness.abort().catch(() => {});
    },
  };
}

