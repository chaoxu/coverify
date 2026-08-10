// Provider registry, per-role model specs, runRole, harness sessions, usage
// accounting. Subscription CLI transports live in backends.ts. Mechanics only
// (design rule 2): how a model gets called, never what it is told.
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
import {
  NOOP_TELEMETRY_CONTEXT,
  type TelemetryContext,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";

export type Models = ReturnType<typeof createModels>;

export async function buildModels(): Promise<Models> {
  // Persistent store so OAuth subscription logins survive across runs.
  const models = createModels({ credentials: fileCredentialStore() });
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(openaiCodexProvider());
  models.setProvider(googleProvider());
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

/** Subscription-only defaults (user decision, 2026-08-01), overridable via
 *  COVERIFY_MODEL_<ROLE>. The hostile auditor stays on a different family so
 *  every candidate gets one cross-family check; it goes through the official
 *  `claude` CLI because third-party OAuth against Anthropic draws Extra
 *  Credits. */
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

const envSpec = (env: string, fallback: string): ModelSpec =>
  parseModelSpec(process.env[env] ?? fallback);

/** Is this provider usable right now — CLI binary on PATH, or a credential the
 *  registry resolves? One answer for the prove() preflight and dispatch-time
 *  family checks; they must never disagree. */
export async function providerUsable(models: Models, provider: ModelSpec["provider"]): Promise<boolean> {
  if (isCliProvider(provider)) {
    const { spawnSync } = await import("node:child_process");
    // Substitute {repo} BEFORE probing: `which "{repo}/bin/agy-oracle"` refused
    // 10/10 gemini dispatches while the wrapper worked (2026-08-09).
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

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Thinking-level-only override, inheriting provider and model from the resolved
 * spec. `COVERIFY_EFFORT_<ROLE>` beats `COVERIFY_EFFORT`; unset changes nothing
 * (rule 3). Exists so issue #31's A/B can vary effort alone — respelling the
 * whole spec can silently change the model too. An invalid value hard-stops
 * rather than falling back, so a typo cannot make an arm compare to itself.
 */
function effortOverride(role: RoleName): ThinkingLevel | undefined {
  const raw = process.env[`COVERIFY_EFFORT_${ROLE_ENV[role].replace("COVERIFY_MODEL_", "")}`] ??
    process.env.COVERIFY_EFFORT;
  if (raw === undefined) return undefined;
  if (!(THINKING_LEVELS as string[]).includes(raw)) {
    throw new Error(
      `invalid reasoning effort "${raw}" (valid: ${THINKING_LEVELS.join(", ")}). ` +
        "Refusing to fall back to the default: a silently ignored effort setting would make an " +
        "A/B compare an arm against itself.",
    );
  }
  return raw as ThinkingLevel;
}

/** Resolution: COVERIFY_EFFORT[_<ROLE>] (thinking only) > COVERIFY_MODEL_<ROLE>
 *  > role default (every role has one). */
export function roleModelSpec(role: RoleName): ModelSpec {
  const spec = envSpec(ROLE_ENV[role], ROLE_DEFAULTS[role]);
  const thinking = effortOverride(role);
  return thinking === undefined ? spec : { ...spec, thinking };
}

/** Ideation families (user decision, 2026-08-09): a reasoner dispatch may carry
 *  family:"fable"|"gemini"|"pro" to run that one worker on another model family
 *  — decorrelated proposals through the same charge and gates (Danus study:
 *  same-family swarms added no new ideas). All are subscription-billed CLIs and
 *  single-shot toolless consults, so the packet must inline everything.
 *  Overridable via COVERIFY_FAMILY_<NAME>. For "pro", the oracle parse enforces
 *  served-model attestation: a router-downgraded reply is discarded as "no
 *  useful response", so weak-model advice cannot enter wearing a Pro label. */
const FAMILY_SPECS: Record<string, string> = {
  // Repointed to Opus 2026-08-09 (Fable quota exhausted); the name stays as the
  // Anthropic-lane label coordinators know, and dispatch records stamp the
  // resolved model.
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

/** Resolve an ideation-family request to a usable spec, or a refusal reason the
 *  coordinator can act on in the same turn. */
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

/** Spec including thinking level. Journalled in the run-config stamp and per
 *  usage event; this string is the join between them, so both must spell it
 *  identically. */
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
  /** Workspace tools: read/ls/grep, scoped write; run_script iff code;
   *  librarian search iff literature. */
  workspace?: {
    cwd: string;
    scope: WriteScope;
    code?: boolean;
    literature?: boolean;
    /** Campaign FAILED.md, enabling keyed lookup of closed routes (#28). */
    failedLedger?: string;
  };
  extraTools?: AgentTool[];
  spec: ModelSpec;
  models: Models;
}

/**
 * Run one fresh, ephemeral, toolless role instance (the single-shot verdict
 * roles): an in-memory harness session on API providers, an official CLI
 * otherwise. Coordinator and dispatched agents instead run durable sessions via
 * createHarnessRoleSession. What an instance sees is decided by the bundle its
 * caller builds.
 */
export async function runRole(
  run: Omit<RoleRun, "workspace" | "extraTools">,
  signal?: AbortSignal,
  /** Parent span, when the caller has one: a TelemetrySpan IS a context, so
   *  passing it makes this call a child structurally. Omitted, the span roots
   *  under the process context (NOOP without an exporter). */
  parent?: TelemetryContext,
): Promise<RoleResult> {
  // No span of its own, deliberately: the SESSION opens the provider_call span
  // (a harness turn in `ask`, a CLI answer in the wrapper below), so this call
  // has exactly one writer. Wrapping here as well made every single-shot role
  // emit two leaves for one payment — an outer span carrying the session total
  // and an inner one carrying the same delta.
  return runRoleInner(run, signal, parent);
}

/** The measurement sink. Injected by cli.ts via runCampaign; NOOP until then,
 *  so core never imports src/telemetry/ and that folder stays deletable. */
let sink: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
export function setTelemetrySink(next: TelemetryContext): void {
  sink = next;
}
export function telemetrySink(): TelemetryContext {
  return sink;
}

/**
 * Whether a billed provider call writes its own leaf. The rule this serves:
 * EXACTLY ONE WRITER PER BILLED CALL. With a sink installed, every span-wrapped
 * call appends a `role-call` leaf, so records that merely REFERENCE that call
 * (a completion, a coordinator wake event, a gate verdict) carry their join key
 * and no tokens — otherwise both write the same payment and `coverify spend`
 * counts it twice. Without a sink there is no leaf, so those records stay the
 * single writer and a sink-less harness still counts its tokens.
 */
export function spendLeafed(): boolean {
  return sink !== NOOP_TELEMETRY_CONTEXT;
}

/** The token fields a non-leaf record may carry, per `spendLeafed`. Absent
 *  fields are dropped rather than written as zero (absent ≠ zero; see
 *  RoleUsage). One helper so a new record kind cannot re-introduce the second
 *  writer by hand. */
export function spendFields(f: {
  usage?: RoleUsage;
  attempts?: number;
  requests?: number;
}): { usage?: RoleUsage; attempts?: number; requests?: number } {
  if (spendLeafed()) return {};
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

/**
 * Give a session that reports usage only when its single answer lands (a
 * spawned CLI) the same span treatment `ask` has on a harness session, plus the
 * `setTelemetryParent` a dispatch needs. Without it a `fable`/`gemini`/`pro`-
 * routed reasoner produced no leaf at all and the dispatch span's parent edge
 * silently no-op'd.
 */
export function withProviderCallSpan<T extends RoleSession>(session: T, spec: ModelSpec): T {
  let spanParent: TelemetryContext | undefined;
  return {
    ...session,
    setTelemetryParent(parent: TelemetryContext): void {
      spanParent = parent;
    },
    ask(prompt: string): Promise<string> {
      return (spanParent ?? sink).startSpan(
        { name: "coverify.provider_call", attributes: { "coverify.model_spec": specKey(spec) } },
        async (span) => {
          // A CLI session answers once, so its cumulative total IS this call's
          // delta; the baseline is kept anyway so a future multi-ask backend
          // cannot start double-counting silently.
          const before = session.usage();
          try {
            return await session.ask(prompt);
          } finally {
            const after = session.usage();
            // No usage means the lane reported none (absent ≠ zero): the leaf
            // is still written, which is what distinguishes a call nobody could
            // meter from a call that cost nothing.
            if (after !== undefined) {
              recordProviderCall(span, subUsage(after, before), {
                attempts: session.attempts?.(),
                requests: session.requests?.(),
              });
            }
          }
        },
      );
    },
  };
}

/** Attach a billed call's tokens to its span. Absent fields stay absent:
 *  absent ≠ zero; see RoleUsage. */
function recordProviderCall(
  span: TelemetrySpan,
  usage: RoleUsage,
  counts?: { attempts?: number; requests?: number },
): void {
  span.setAttributes({
    "coverify.tokens.input": usage.input,
    "coverify.tokens.cache_read": usage.cacheRead,
    "coverify.tokens.output": usage.output,
    "coverify.tokens.cache_write": usage.cacheWrite,
    "coverify.tokens.reasoning": usage.reasoning,
    "coverify.meter": usage.meter,
    "coverify.attempts": counts?.attempts,
    "coverify.requests": counts?.requests,
  });
}

async function runRoleInner(
  run: Omit<RoleRun, "workspace" | "extraTools">,
  signal?: AbortSignal,
  parent?: TelemetryContext,
): Promise<RoleResult> {
  const started = Date.now();
  // One invocation surface: every role call is a session asked once. A CLI
  // backend is a degenerate session (answers once, stoppable, not steerable);
  // an API provider gets an in-memory harness session whose id becomes pi's
  // prompt_cache_key — ~80% prefix-cache hit measured (f0ad016).
  const cli = isCliProvider(run.spec.provider)
    ? withProviderCallSpan(createCliRoleSession(run, signal), run.spec)
    : undefined;
  if (parent !== undefined) cli?.setTelemetryParent?.(parent);
  const session =
    cli ?? (await createHarnessRoleSession(run, { sessionId: randomUUID(), ephemeral: true, parent }));
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
    // What actually went over the wire (the CLI path inlines contract+charge).
    promptChars: cli ? cli.promptChars() : run.prompt.length,
    durationMs: Date.now() - started,
  };
}

export interface RoleSession {
  /** Nest this session's turns under a span created after the session was.
   *  A worker's dispatch span opens around the promise, not the constructor. */
  setTelemetryParent?(parent: TelemetryContext): void;
  /** Stated, not inferred from which fields exist: a spawned CLI answers once
   *  and is stoppable but not steerable; a harness session is steerable, and
   *  durable when its transcript persists. */
  readonly capabilities: { steerable: boolean; durable: boolean };
  ask(prompt: string): Promise<string>;
  /** Context size in tokens from pi's estimator over the context messages. */
  approxTokens(): number;
  /** Cumulative provider-reported usage; undefined when the backend reported
   *  none (absent ≠ zero; see RoleUsage). */
  usage(): RoleUsage | undefined;
  /** Server-attested served model (oracle backends only; issue #20). Undefined
   *  elsewhere — never an echo of the request. */
  servedModel?(): string | undefined;
  /** Self-reported model, when the backend states one (#21 P3). */
  reportedModel?(): string | undefined;
  /** Provider calls whose tokens cannot be measured. Real spend, recorded as a
   *  gap so it never reads as costing nothing. */
  unmetered?(): { lane: string; detail: string }[];
  /** Provider attempts, retries included. A retry re-presents the whole context
   *  and is billed again but leaves no message, so it is unrecoverable from the
   *  transcript afterwards. */
  attempts?(): number;
  /** Provider requests that produced output. Derived from the transcript, never
   *  a second source that can drift. */
  requests?(): number;
  /** Join key into the provider's own transcript (codex lane: the rollout under
   *  ~/.codex/sessions/ carrying rate_limits.primary.used_percent, which is
   *  account-wide and never coverify-attributable). */
  providerSessionId?(): string | undefined;
  /** Second route to the same transcript when the id is unavailable. */
  backendCwd?(): string | undefined;
  /** In-place lossy compaction (harness sessions only). The caller owns the
   *  policy and the contract's post-compaction reread rule. */
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


/** Which parser produced a usage record. NOT a convention discriminator — all
 *  three normalize `input` to the uncached part. It is provenance: which
 *  adapter to go fix when a number looks wrong. */
export type Meter = "pi-session" | "codex-cli-jsonl" | "claude-cli-json";

/** Coverify's usage record: pi's `Usage` minus what only pi can compute, plus
 *  provenance. Derived from pi's type rather than paralleling it, because
 *  telemetry/turns.ts parses pi's session JSONL as a RoleUsage — a pi upgrade would
 *  otherwise break the two silently.
 *
 *  CANONICAL RULES for usage numbers everywhere in this codebase:
 *  - Absent ≠ measured zero. `cacheWrite` is optional here though required in
 *    pi's type: cache_write_input_tokens is absent upstream on both the pi and
 *    codex-cli lanes (codex #32479, pi #6469), so a 0 there is a broken meter,
 *    not a measurement. Every reader, summer, and renderer must preserve the
 *    distinction rather than coercing absence to 0.
 *  - `reasoning` is a SUBSET of `output`; adding it to output double-counts.
 *    Undefined when the provider exposes no breakdown.
 *  - `cacheWrite1h` is omitted rather than inherited: no lane sets it and
 *    neither combinator carries it, and a field addUsage silently drops is how
 *    a sum starts losing tokens on the next pi upgrade. */
export type RoleUsage = Omit<PiUsage, "cost" | "totalTokens" | "cacheWrite" | "cacheWrite1h"> & {
  cacheWrite?: number;
  /** Provenance, not convention (see Meter). Absent before 2026-08-09. */
  meter?: Meter;
  /** No dollar field, deliberately: every role runs on a subscription lane, so
   *  every provider-reported price is notional list price, not money spent. A
   *  reader wanting dollars applies a rate table at read time. */
};

/** Field-wise sum of two usages FROM THE SAME METER; an optional field stays
 *  absent unless some addend reported it (absent ≠ zero; see RoleUsage). `M` is
 *  bound by `a`'s meter, so a cross-meter sum is a type error at the call site
 *  rather than merely discouraged (issue #32). Type-level and not a runtime
 *  throw — see the totality note in the body. */
export function addUsage<M extends Meter | undefined>(
  a: RoleUsage & { meter?: M },
  b: RoleUsage & { meter?: NoInfer<M> },
): RoleUsage {
  const reported = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  // Deliberately TOTAL: this runs inside persist()'s store.append on the settle
  // path, where a throw skips the completion record and rejects handle.settled
  // (contract: "resolves, never rejects"), killing the campaign with every live
  // agent's work unharvested. Observability may not end a campaign (rule 2).
  const sum: RoleUsage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: reported(a.cacheWrite, b.cacheWrite),
    reasoning: reported(a.reasoning, b.reasoning),
  };
  // Provenance survives only when both addends agree; mixing a stamped record
  // with an unstamped one leaves it absent, because "unknown" is the truth.
  if (a.meter !== undefined && a.meter === b.meter) sum.meter = a.meter;
  return sum;
}

/** `a - b`, field-wise, turning a cumulative session total into the leaf each
 *  wake actually spent (absent ≠ zero; see RoleUsage). Clamped at zero: a
 *  session total is monotone, so a negative means the baseline came from
 *  another session, and a negative token count poisons every sum downstream. */
export function subUsage(a: RoleUsage, b?: RoleUsage): RoleUsage & { nonMonotone?: true } {
  // Copy, never alias: the caller keeps `a` as the next baseline while this
  // result is journalled.
  if (b === undefined) return { ...a };
  let clamped = false;
  const clamp = (x: number) => {
    if (x >= 0) return x;
    clamped = true;
    return 0;
  };
  // An absent minuend stays absent (absent ≠ zero; see RoleUsage).
  const less = (x?: number, y?: number) => (x === undefined ? undefined : clamp(x - (y ?? 0)));
  const d: RoleUsage & { nonMonotone?: true } = {
    input: clamp(a.input - b.input),
    output: clamp(a.output - b.output),
    cacheRead: clamp(a.cacheRead - b.cacheRead),
    cacheWrite: less(a.cacheWrite, b.cacheWrite),
    reasoning: less(a.reasoning, b.reasoning),
  };
  if (a.meter !== undefined) d.meter = a.meter;
  // The clamp is a last line of defence, not a silent correction: if totals
  // ever stop being monotone, real spend vanishes into it. Mark it.
  if (clamped) d.nonMonotone = true;
  return d;
}

/** The one accumulation rule for pi-lane usage. Exported because telemetry/turns.ts
 *  rebuilds the same totals from pi's session JSONL; their agreement is the
 *  2026-08-09 study's only genuine cross-check (agreed to 0.2%, and the one 41%
 *  disagreement located a real defect). A second copy would make that check
 *  compare the rule against a stale fork of itself (issue #43). */
export function sumMessagesUsage(messages: readonly unknown[]): RoleUsage {
  const total: RoleUsage = { input: 0, output: 0, cacheRead: 0, meter: "pi-session" };
  // cacheWrite deliberately NOT initialised (absent ≠ zero; see RoleUsage).
  // Drop this guard the day upstream actually reports it.
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
  /** Undefined when the backend reported no usage (absent ≠ zero; see RoleUsage). */
  usage?: RoleUsage;
  /** Request-shape telemetry for single-shot roles (their only "turn"). */
  promptChars?: number;
  durationMs?: number;
  /** Server-attested served model (oracle backends): records must prefer it
   *  over the requested spec label (issue #20 — the spec is testimony, this is
   *  attestation). */
  servedModel?: string;
  /** Self-reported model (claude-cli JSON). Journalled beside the requested
   *  spec; never enforced (#21 P3, rule 3). */
  reportedModel?: string;
  /** Provider-side transcript join keys (codex lane); see RoleSession. */
  providerSessionId?: string;
  backendCwd?: string;
  /** Without these, a record spanning a tool loop cannot be told from one
   *  spanning retries. */
  attempts?: number;
  requests?: number;
}

export type HarnessSessionOpts = {
  /** Stable session identity; becomes the provider's prompt_cache_key (keep
   *  ≤64 chars). */
  sessionId: string;
  /** Parent span, so each turn nests under its dispatch or wake rather than
   *  rooting on its own. */
  parent?: TelemetryContext;
} & (
  | {
      /** Directory for durable session trees (e.g. <campaign>/.coverify/sessions). */
      sessionsRoot: string;
      cwd: string;
      ephemeral?: false;
    }
  /** In-memory session: same harness surface and cache keying, nothing written
   *  under .coverify/sessions/. */
  | { ephemeral: true }
);

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

/** Role session on pi's AgentHarness: durable append-only JSONL session tree by
 *  default, in-memory under `ephemeral`. The harness layer rather than
 *  pi-coding-agent's createAgentSession because it takes systemPrompt verbatim
 *  (prompt purity by construction) with zero disk/env discovery. */
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
        failedLedger: run.workspace.failedLedger,
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
    // openai-codex honors this; others ignore it. "auto" holds one WebSocket
    // open for the whole turn, and 2026-08-08 measured ~25% of long turns
    // dying mid-stream with close code 1006 (pi's SSE fallback arms only for
    // the session's NEXT turn, which an ask-once worker never has). "sse" has
    // no long-lived socket. Read at call time.
    streamOptions: {
      transport: codexTransport(),
    },
    // Verified pi 0.83.0: AgentHarness reads this ONLY for compaction and
    // branch-summary calls, never the prompt path (a live 1006 sailed through
    // with it set, 2026-08-08). Ordinary turns are retried by the
    // retryAssistantCall wrapper in ask() below.
    retry: retryPolicy(),
    // Verbatim — the harness layer performs no prompt assembly of its own.
    systemPrompt: systemText(run),
    tools,
    activeToolNames: tools.map((t) => t.name),
    resources: {},
  });
  // Wire logging must use the harness's own hooks; the Agent-ctor onPayload
  // path does not exist at this layer and silently logs nothing.
  const wirePath = process.env.COVERIFY_WIRE_LOG;
  if (wirePath) {
    const logPayload = wireLogPayload(wirePath);
    harness.on("before_provider_payload", (e) => {
      logPayload((e as { payload?: unknown }).payload, (e as { model?: unknown }).model);
      return undefined;
    });
    // No response-side records: pi 0.83.0 types after_provider_response but
    // never emits it on this provider path (verified 2026-08-02). Revisit on
    // upgrade; until then the wire log is request-side only.
  }
  // Sync RoleSession surface over async storage; the cache refreshes after
  // every completed run. Two views on purpose: `allMessages` (every message
  // ever, so usage totals never un-count compacted spend) vs `contextMessages`
  // (what the model actually sees next call).
  let allMessages: AgentMessage[] = [];
  let contextMessages: AgentMessage[] = [];
  // Empty total from the same builder refresh uses: a literal fabricates
  // `cacheWrite: 0` and carries no meter, so addUsage would drop provenance for
  // any usage() read before the first refresh.
  let compactionUsage: RoleUsage = sumMessagesUsage([]);
  const refresh = async () => {
    // getEntries (not getBranch): totals must keep counting everything ever
    // spent, including entries a compaction superseded.
    const entries = await session.getEntries();
    allMessages = entries.flatMap((e) => (e.type === "message" ? [e.message] : []));
    // The summarization call's own spend lives on the compaction entry, not on
    // any assistant message; without this every compaction vanishes from usage.
    compactionUsage = sumMessagesUsage(
      entries.flatMap((e) =>
        e.type === "compaction" && (e as { usage?: unknown }).usage
          ? [{ role: "assistant", usage: (e as { usage?: unknown }).usage }]
          : [],
      ),
    );
    contextMessages = (await session.buildContext()).messages;
  };
  let attempts = 0;
  const unmetered: { lane: string; detail: string }[] = [];
  // Cancellation must also cover the retry wrapper's backoff sleeps:
  // harness.abort() only aborts an in-flight prompt, and between attempts there
  // is none. retryAssistantCall honors this controller as terminal.
  const sessionStop = new AbortController();
  let spanParent: TelemetryContext | undefined = opts.parent;
  const askTurn = async (prompt: string): Promise<string> => {
      // Turn-level retry at the ask boundary: retryAssistantCall restarts the
      // turn on transient transport failures with backoff, while quota/billing
      // errors and aborts stay fail-fast. 2026-08-08 measured ~30% of long Sol
      // worker turns dying to such drops on both transports.
      const final = await retryAssistantCall(
        async () => {
          // One provider attempt. Not derivable from the transcript afterwards:
          // without it a 500k-token turn is indistinguishable from three 170k
          // attempts (docs/journal-shape.md rule 13).
          attempts++;
          try {
            return (await harness.prompt(prompt)) as AssistantMessage;
          } finally {
            // Spend must be recorded even when the run rejects: a failed
            // 500k-token run logged as zero usage is worse than the failure.
            await refresh().catch(() => {});
          }
        },
        retryPolicy(),
        sessionStop.signal,
      );
      // The harness resolves failures as a synthetic message; surface the real
      // cause rather than an empty string, which would read as the empty-report
      // infra failure and trigger a pointless salvage nudge.
      if (final.stopReason === "error") {
        // Classify overflow with pi's own predicate while the structured message
        // still exists (issue #24); the appended marker is what the harness
        // diagnosis keys on, independent of provider phrasing.
        const overflow = isContextOverflow(final) ? " [context window exceeded]" : "";
        const err = new Error((final.errorMessage ?? "provider error (no message)") + overflow);
        // Salvage: pi's errored message IS the object that accumulated the
        // stream, so a turn dying at minute 29 of 30 still holds every block it
        // received (BET measured a 50% failure rate on ~30-minute turns). The
        // harness persists it as PARTIAL evidence; the completion stays a
        // failure.
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
  };
  return {
    capabilities: { steerable: true, durable: !opts.ephemeral },
    /** Each billed turn is a span. Without this the coordinator and every
     *  dispatched worker — ~93% of presented tokens — emitted nothing, because
     *  only the single-shot lane went through runRole. */
    ask(prompt: string): Promise<string> {
      return (spanParent ?? sink).startSpan(
        { name: "coverify.provider_call", attributes: { "coverify.model_spec": specKey(run.spec) } },
        async (span) => {
          // usage() is CUMULATIVE over the session, so this turn is the delta.
          const before = addUsage(sumMessagesUsage(allMessages), compactionUsage);
          const attemptsBefore = attempts;
          const requestsBefore = allMessages.filter((m) => (m as { role?: string }).role === "assistant").length;
          try {
            return await askTurn(prompt);
          } finally {
            const after = addUsage(sumMessagesUsage(allMessages), compactionUsage);
            const requestsAfter = allMessages.filter((m) => (m as { role?: string }).role === "assistant").length;
            recordProviderCall(span, subUsage(after, before), {
              attempts: attempts - attemptsBefore,
              requests: Math.max(0, requestsAfter - requestsBefore),
            });
          }
        },
      );
    },
    setTelemetryParent(parent: TelemetryContext): void {
      spanParent = parent;
    },
    approxTokens(): number {
      return estimateContextTokens(contextMessages).tokens;
    },
    usage(): RoleUsage {
      return addUsage(sumMessagesUsage(allMessages), compactionUsage);
    },
    attempts: () => attempts,
    unmetered: () => unmetered,
    // Derived, not counted twice: a stamped duplicate of derivable state is a
    // second source that can drift.
    requests: () => allMessages.filter((m) => (m as { role?: string }).role === "assistant").length,
    async compact(customInstructions?: string): Promise<void> {
      // A real provider call whose tokens are already inside usage(); not
      // counting it makes usage and attempts disagree on every compacted
      // session.
      attempts++;
      await harness.compact(customInstructions);
      await refresh();
    },
    steer(text: string): Promise<boolean> {
      // AgentHarness.steer REJECTS when idle. A dropped steer is routine but an
      // unhandled rejection kills the process, so resolve to a boolean.
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

