// The measurement tree as a formal span schema (@earendil-works/pi-telemetry).
//
// Two kinds of record, not interchangeable: the gate store is BUSINESS STATE
// (content-hash-bound, read back to decide what a campaign may do, never
// dependent on an exporter), spans are DIAGNOSTIC — "recording a span must not
// change whether the operation runs, succeeds, fails, or is persisted," which
// is CLAUDE.md rule 2 in pi-telemetry's words.
//
// Spans write the measurement half of the journal: cli.ts installs
// JournalTelemetryContext, turning each provider_call span into a role-call
// leaf. Under the NOOP context a run loses every token number and not one
// verdict. The declared `parents` edges replace hand-stamped runId/wake/
// dispatchId fields, and are the seam an OpenTelemetry exporter plugs into.
import { defineTelemetrySchema } from "@earendil-works/pi-telemetry";

const tokens = (description: string) =>
  ({ type: "number", description, cardinality: "high" }) as const;

/** The campaign → run → wake → dispatch → stage → provider-request tree. Token
 *  attributes mirror RoleUsage, not a vendor's shape: `input` is the uncached
 *  part on every lane, `reasoning` is a SUBSET of `output`, and `meter` names
 *  the lane because lanes bill to different accounts and are never summed. An
 *  exporter flattening these into one "tokens" counter reintroduces the error
 *  docs/journal-shape.md exists to prevent. */
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
      description:
        "One coordinator turn. DECLARED BUT NOT EMITTED by this harness: the wake loop is a " +
        "`while (true)` with four returns and two continues, and a callback-scoped span means " +
        "converting all six in the event loop, which no test drives. The ordinal reaches every " +
        "leaf as an attribute on the dispatch spans instead, so the journal is identical; an " +
        "exporter that wants the tree level is the reason to pay for the restructure.",
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
      events: {},
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
          values: ["pi-session", "codex-cli-jsonl", "claude-cli-json", "agy-json"],
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
