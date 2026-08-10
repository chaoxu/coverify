// The measurement tree as a formal span schema (@earendil-works/pi-telemetry).
//
// WHY THIS AND NOT THE JOURNAL. Coverify has two kinds of record and they are
// not interchangeable:
//
//   - The gate store is BUSINESS STATE. checkPromotion, priorReusableRecord
//     and retractionClosure read it back to decide what a campaign may do, and
//     records are content-hash-bound. It is authoritative, it lives outside
//     the campaign tree so no role's write tools can reach it, and it must
//     never depend on an exporter being configured.
//   - Spans are DIAGNOSTIC. pi-telemetry states the rule its own way:
//     "recording a span must not change whether the operation runs, succeeds,
//     fails, or is persisted." That is CLAUDE.md rule 2 in different words —
//     observability must be removable without changing campaign behaviour.
//
// So this does not replace the journal and does not duplicate it either: the
// default context is NOOP, so nothing is emitted unless an operator attaches
// an exporter. What the schema buys, today, is that the tree the journal has
// been threading BY HAND — runId on every record, wake on every dispatch,
// dispatchId on every stage — is now written down once, formally, with the
// parent of each span declared. Three separate reviews found gaps in that
// hand-threading; a declared parent is the structural version of the rule.
//
// It is also the seam an OpenTelemetry exporter plugs into without touching
// any call site, which is the only reason to prefer a vendor-neutral contract
// over ad-hoc logging.
import {
  InMemoryTelemetryContext,
  NOOP_TELEMETRY_CONTEXT,
  defineTelemetrySchema,
  type TelemetryContext,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";

const tokens = (description: string) =>
  ({ type: "number", description, cardinality: "high" }) as const;

/**
 * The campaign → run → wake → dispatch → stage → provider-request tree,
 * declared. Every `parents` clause here is an edge that used to exist only as
 * a field somebody remembered to stamp.
 *
 * Token attributes deliberately mirror RoleUsage and NOT a vendor's shape:
 * `input` is the uncached part on every lane, `reasoning` is a SUBSET of
 * `output` (pi's Usage contract, so adding them double-counts), and `meter`
 * names the lane because the lanes bill to different accounts and must never
 * be summed together. An exporter that flattens these into one "tokens"
 * counter would reintroduce the exact error docs/measurement-protocol.md
 * exists to prevent, so the meaning travels with the attribute.
 */
export const COVERIFY_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    "coverify.run": {
      description: "One harness process against one campaign.",
      parents: { kind: "root_or_external" },
      startAttributes: {
        "coverify.run_id": {
          type: "string",
          description: "Run identity, stamped on every gate record this process writes.",
          required: true,
          cardinality: "high",
        },
        "coverify.harness_rev": {
          type: "string",
          description: "Harness git revision.",
          required: false,
          cardinality: "high",
        },
        "coverify.launcher_sha256": {
          type: "string",
          description: "Hash of the launcher contract that governed this run.",
          required: false,
          cardinality: "high",
        },
      },
      endAttributes: {
        "coverify.wakes": { type: "number", description: "Coordinator wakes in this run.", cardinality: "high" },
      },
      events: {},
      status: { default: "ok", errorWhen: "the operation threw" },
    },
    "coverify.wake": {
      description: "One coordinator turn: the unit the campaign advances in.",
      parents: { kind: "spans", spans: ["coverify.run"] },
      startAttributes: {
        "coverify.wake": { type: "number", description: "Wake ordinal.", required: true, cardinality: "high" },
      },
      endAttributes: {
        "coverify.context_tokens": {
          type: "number",
          description: "Approximate coordinator context after the turn.",
          cardinality: "high",
        },
      },
      status: { default: "ok", errorWhen: "the turn failed after its retries" },
      events: {
        "coverify.compaction": {
          description: "In-place context compaction; a real provider call that leaves no message.",
          attributes: {
            "coverify.context_tokens_before": { type: "number", description: "Before.", required: true, cardinality: "high" },
            "coverify.context_tokens_after": { type: "number", description: "After.", required: true, cardinality: "high" },
          },
        },
      },
    },
    "coverify.dispatch": {
      description: "One unit of delegated work: a worker, a gate critic, or a verification cadence.",
      parents: { kind: "spans", spans: ["coverify.wake"] },
      startAttributes: {
        "coverify.dispatch_id": { type: "string", description: "Handle id.", required: true, cardinality: "high" },
        "coverify.role": {
          type: "string",
          description: "Which role this dispatch runs.",
          required: true,
          values: ["reasoner", "technician", "gate-critic", "verification"],
          cardinality: "low",
        },
        "coverify.mechanism": { type: "string", description: "Mechanism label.", required: false, cardinality: "high" },
      },
      endAttributes: {
        "coverify.cancelled": { type: "boolean", description: "Cancelled before it settled.", cardinality: "low" },
        "coverify.failed": { type: "boolean", description: "Infrastructure failure, not a verdict.", cardinality: "low" },
      },
      events: {},
      status: { default: "ok", errorWhen: "the operation threw" },
    },
    "coverify.stage": {
      description: "One verification stage: hostile audit, bundle certification, blind reconstruction, comparison.",
      parents: { kind: "spans", spans: ["coverify.dispatch"] },
      startAttributes: {
        "coverify.stage": {
          type: "string",
          description: "Which stage.",
          required: true,
          values: ["audit", "bundle-cert", "reconstruction", "comparison"],
          cardinality: "low",
        },
        "coverify.revision": { type: "string", description: "Candidate revision identity.", required: true, cardinality: "high" },
      },
      endAttributes: {
        "coverify.verdict": { type: "string", description: "PASS, FAIL, or UNPARSEABLE.", cardinality: "low" },
        "coverify.carried_forward": {
          type: "boolean",
          description: "Reused a prior stage record instead of buying the call again.",
          cardinality: "low",
        },
      },
      events: {},
      status: { default: "ok", errorWhen: "the operation threw" },
    },
    "coverify.provider_call": {
      description:
        "One billed provider request. The LEAF: spend is recorded here and nowhere above, so every " +
        "aggregate is a GROUP BY over leaves rather than a stored summary that can disagree with them.",
      parents: { kind: "any" },
      startAttributes: {
        "coverify.model_spec": {
          type: "string",
          description: "provider/model@thinking — the effort setting included, which a bare model id drops.",
          required: true,
          cardinality: "high",
        },
        "coverify.meter": {
          type: "string",
          description: "Which accounting lane billed this. Lanes are never summed together.",
          required: true,
          values: ["pi-session", "codex-cli-jsonl", "claude-cli-json"],
          cardinality: "low",
        },
      },
      endAttributes: {
        "coverify.tokens.input": tokens("Uncached input tokens (the uncached part on EVERY lane)."),
        "coverify.tokens.cache_read": tokens("Input served from cache."),
        "coverify.tokens.cache_write": tokens("Cache writes; absent when the backend does not report them."),
        "coverify.tokens.output": tokens("Output tokens."),
        "coverify.tokens.reasoning": tokens("Reasoning tokens — a SUBSET of output; adding them double-counts."),
        "coverify.attempts": {
          type: "number",
          description: "Provider attempts including retries. The one count no later reader can reconstruct.",
          cardinality: "high",
        },
        "coverify.requests": { type: "number", description: "Provider requests in this call.", cardinality: "high" },
      },
      events: {},
      status: { default: "ok", errorWhen: "the operation threw" },
    },
  },
} as const);

/**
 * The process-wide context. NOOP unless an operator asks for something else,
 * so a campaign with no exporter behaves exactly as it did — which is the
 * property that lets this be deleted without changing any campaign outcome.
 *
 * `memory` attaches the reference in-process recorder, which is what the tests
 * assert the tree shape against. A real OpenTelemetry adapter is a third case
 * here and touches no call site (#46).
 */
let context: TelemetryContext = NOOP_TELEMETRY_CONTEXT;

export function setTelemetryContext(next: TelemetryContext): void {
  context = next;
}

export function telemetry(): TelemetryContext {
  return context;
}

/** Reference recorder, for tests and for `COVERIFY_TELEMETRY=memory`. */
export function useInMemoryTelemetry(): InMemoryTelemetryContext {
  const ctx = new InMemoryTelemetryContext();
  context = ctx;
  return ctx;
}

/** Configure from the environment. Called once at campaign start. */
export function initTelemetry(mode: string | undefined): void {
  context = mode === "memory" ? new InMemoryTelemetryContext() : NOOP_TELEMETRY_CONTEXT;
}

/**
 * Record one billed provider call on the current span.
 *
 * Absent token fields stay ABSENT rather than becoming zero: "the backend
 * never reported this" and "the backend measured zero" are different facts,
 * and collapsing them is how a broken meter's zero gets read as evidence.
 */
export function recordProviderCall(
  span: TelemetrySpan,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite?: number;
    reasoning?: number;
    meter?: string;
  },
  counts?: { attempts?: number; requests?: number },
): void {
  span.setAttributes({
    "coverify.tokens.input": usage.input,
    "coverify.tokens.cache_read": usage.cacheRead,
    "coverify.tokens.output": usage.output,
    "coverify.tokens.cache_write": usage.cacheWrite,
    "coverify.tokens.reasoning": usage.reasoning,
    "coverify.attempts": counts?.attempts,
    "coverify.requests": counts?.requests,
  });
}
