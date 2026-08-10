// The recording path for MEASUREMENT. Deleting this whole folder must leave a
// working harness that proves theorems and records verdicts — it only stops
// counting tokens. That is the test for whether anything in here belongs.
//
// Core never imports this folder. cli.ts (the composition root) builds a
// context and hands it to runCampaign; core holds only the `TelemetryContext`
// TYPE from the pi-telemetry package, which erases at runtime, and defaults to
// NOOP. So `rm -rf src/telemetry` plus three lines in cli.ts is a clean
// removal, not a surgery.
import type {
  SpanAttributes,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import type { GateStore } from "../gates.js";

/** What a span carries that becomes a record field. */
interface SpanState {
  name: string;
  attributes: SpanAttributes;
  parent?: SpanState;
}

/** The attribute that identifies a span's dispatch, searched up the ancestry.
 *  This is the point of the whole exercise: `dispatchId`, `wake` and `runId`
 *  used to be copied onto each record by hand, and three reviews found gaps in
 *  the copying. Here the edge is the tree. */
function inherited(s: SpanState | undefined, key: string): unknown {
  for (let n = s; n !== undefined; n = n.parent) {
    const v = n.attributes[key];
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Writes one `role-call` leaf per billed provider call, with its parent edges
 * read off the span tree.
 *
 * Only provider_call spans persist. The others exist to carry the edges and to
 * give an exporter its shape; writing a record for a wake or a dispatch here
 * would duplicate what the harness already records as campaign state.
 */
export class JournalTelemetryContext implements TelemetryContext {
  constructor(
    private readonly store: GateStore,
    private readonly parent?: SpanState,
  ) {}

  startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const state: SpanState = {
      name: options.name,
      attributes: { ...options.attributes },
      parent: this.parent,
    };
    const span: TelemetrySpan = {
      startSpan: (o, cb) => new JournalTelemetryContext(this.store, state).startSpan(o, cb),
      addEvent: (name, attributes) => {
        if (name === "coverify.compaction") this.write(state, { compaction: true, ...attributes });
      },
      setAttributes: (attributes) => Object.assign(state.attributes, attributes),
      setStatus: (status: SpanStatus) => {
        if (status.status === "error") state.attributes["coverify.error"] = status.error?.message ?? true;
      },
    };
    return (async () => {
      try {
        return await callback(span);
      } finally {
        if (state.name === "coverify.provider_call") this.write(state);
      }
    })();
  }

  /** Span attributes -> the journal's record shape. The names differ because
   *  the journal's are older and every reader and every campaign on disk uses
   *  them; translating here keeps one vocabulary at each end. */
  private write(state: SpanState, extra?: SpanAttributes): void {
    const a = { ...state.attributes, ...extra };
    const num = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : undefined);
    const usage = {
      input: num("coverify.tokens.input") ?? 0,
      output: num("coverify.tokens.output") ?? 0,
      cacheRead: num("coverify.tokens.cache_read") ?? 0,
      cacheWrite: num("coverify.tokens.cache_write"),
      reasoning: num("coverify.tokens.reasoning"),
      meter: typeof a["coverify.meter"] === "string" ? (a["coverify.meter"] as string) : undefined,
    };
    // A call that reported nothing still happened; recording it as a leaf with
    // no usage is what lets a reader tell an unmetered lane from a lost one.
    this.store.append({
      kind: "role-call",
      ...defined({
        dispatchId: inherited(state, "coverify.dispatch_id") as string | undefined,
        wake: inherited(state, "coverify.wake") as number | undefined,
        role: inherited(state, "coverify.role") as string | undefined,
        revision: inherited(state, "coverify.revision") as string | undefined,
        stage: inherited(state, "coverify.stage") as string | undefined,
        modelSpec: a["coverify.model_spec"] as string | undefined,
        attempts: num("coverify.attempts"),
        requests: num("coverify.requests"),
        compaction: a.compaction === true ? true : undefined,
        contextTokensBefore: num("coverify.context_tokens_before"),
        contextTokensAfter: num("coverify.context_tokens_after"),
        unmetered: a["coverify.unmetered"] as string | undefined,
      }),
      ...(usage.meter !== undefined || usage.input > 0 || usage.output > 0 ? { usage: defined(usage) } : {}),
    });
  }
}

function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;
}
