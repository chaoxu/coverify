// The recording path for MEASUREMENT: deleting this folder must leave a
// working harness, only one that stops counting tokens. Core never imports it —
// cli.ts builds the context and hands it to runCampaign, core holds only the
// runtime-erased `TelemetryContext` type and defaults to NOOP — so `rm -rf
// src/telemetry` plus three lines in cli.ts is a clean removal. Keep it that way.
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

/** Attributes are inherited up the ancestry rather than copied onto each record
 *  by hand, so `dispatchId`/`wake`/`runId` cannot go missing. */
function inherited(s: SpanState | undefined, key: string): unknown {
  for (let n = s; n !== undefined; n = n.parent) {
    const v = n.attributes[key];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Writes one `role-call` leaf per billed provider call, with its parent edges
 *  read off the span tree. Only provider_call spans persist — the others carry
 *  edges; persisting a wake or dispatch span would duplicate campaign state the
 *  harness already records. */
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

  /** Span attributes -> the journal's record shape. The names differ; every
   *  reader and every campaign on disk uses the journal's, so translate here.
   *
   *  TOTAL, like `addUsage`: this runs in a `finally`, so a throw here would
   *  replace the callback's outcome — a successful coordinator turn would
   *  become a thrown one and cost the campaign its session. Measurement may
   *  not end a campaign (rule 2), so a failed append loses the leaf and
   *  nothing else. The lost leaf still surfaces: it lands in `coverify
   *  spend`'s unattributed gap rather than being silently absorbed. */
  private write(state: SpanState, extra?: SpanAttributes): void {
    try {
      this.appendLeaf(state, extra);
    } catch {
      /* empty */
    }
  }

  private appendLeaf(state: SpanState, extra?: SpanAttributes): void {
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
    // A call that reported nothing still happened: the usage-less leaf is what
    // distinguishes absent from measured zero (see `RoleUsage` in providers.ts).
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
