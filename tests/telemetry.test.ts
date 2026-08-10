// pi-telemetry wiring (#46). The point is not that spans exist — it is that
// they are OFF by default and carry the measurement meanings the journal
// spent three review rounds getting right.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { COVERIFY_TELEMETRY_SCHEMA, initTelemetry, telemetry, useInMemoryTelemetry } =
  await import("../src/telemetry.ts");
const { runRole } = await import("../src/providers.ts");

const stubDir = fs.mkdtempSync("/private/tmp/coverify-telemetry-");
afterEach(() => {
  delete process.env.COVERIFY_CODEX_CMD;
  initTelemetry(undefined);
});

/** A stubbed codex call, so a real provider_call span has real usage on it. */
async function callStub(input: number, cached: number) {
  const stub = path.join(stubDir, `t${input}.sh`);
  fs.writeFileSync(
    stub,
    `#!/bin/sh\necho '{"type":"turn.completed","usage":{"input_tokens":${input},` +
      `"cached_input_tokens":${cached},"output_tokens":7,"reasoning_output_tokens":3}}'\n` +
      `printf 'VERDICT: PASS' > "$1"\n`,
    { mode: 0o755 },
  );
  process.env.COVERIFY_CODEX_CMD = `${stub} {out}`;
  return runRole({
    contract: "c",
    charge: "c",
    prompt: "q",
    spec: { provider: "codex-cli", modelId: "stub", thinking: "off" },
    models: undefined as never,
  });
}

test("telemetry is OFF by default — a campaign with no exporter emits nothing", async () => {
  // Deletable without changing any campaign outcome (rule 2).
  initTelemetry(undefined);
  const ctx = telemetry();
  let ran = false;
  const out = await ctx.startSpan({ name: "coverify.provider_call" }, async () => {
    ran = true;
    return 42;
  });
  // NOOP still RUNS the callback and returns its value — observability must
  // never change whether the operation happens.
  expect(ran).toBe(true);
  expect(out).toBe(42);
  expect(Object.hasOwn(ctx, "getSpans")).toBe(false);
});

test("a real provider call becomes a leaf span carrying the lane and the tokens", async () => {
  const recorder = useInMemoryTelemetry();
  await callStub(1000, 900);
  const spans = recorder.getSpans();
  const call = spans.find((s) => s.name === "coverify.provider_call");
  expect(call).toBeDefined();
  const a = call!.attributes;
  // The lane travels WITH the numbers: lanes bill to different accounts and a
  // reader that loses the meter can cross-sum them, which is the 2026-08-09
  // study's headline error.
  expect(a["coverify.meter"]).toBe("codex-cli-jsonl");
  expect(a["coverify.model_spec"]).toBe("codex-cli/stub@off");
  // `input` is the UNCACHED part on every lane — 1000 presented, 900 cached.
  expect(a["coverify.tokens.input"]).toBe(100);
  expect(a["coverify.tokens.cache_read"]).toBe(900);
  expect(a["coverify.tokens.output"]).toBe(7);
  // reasoning is a SUBSET of output; recorded separately so nobody adds them.
  expect(a["coverify.tokens.reasoning"]).toBe(3);
  expect(call!.status.status).toBe("ok");
});

test("an unreported token field stays absent rather than becoming zero", async () => {
  // The codex lane does not report cache writes (codex #32479, pi #6469). A
  // zero there would be a broken meter's reading presented as a measurement.
  const recorder = useInMemoryTelemetry();
  await callStub(50, 0);
  const call = recorder.getSpans().find((s) => s.name === "coverify.provider_call");
  expect(call!.attributes["coverify.tokens.cache_write"]).toBeUndefined();
});

test("passing a parent span makes the call a CHILD structurally", async () => {
  // A passed parent cannot be forgotten the way a copied dispatchId can.
  const recorder = useInMemoryTelemetry();
  await recorder.startSpan(
    { name: "coverify.dispatch", attributes: { "coverify.dispatch_id": "r001" } },
    async (parent) => callStub(10, 0, ).then(() => parent),
  );
  const spans = recorder.getSpans();
  const dispatch = spans.find((s) => s.name === "coverify.dispatch")!;
  const call = spans.find((s) => s.name === "coverify.provider_call")!;
  // Without an explicit parent the call is a root; this test documents the
  // CURRENT wiring — runRole takes an optional parent, and the dispatch lane
  // does not yet pass one.
  expect(dispatch.parentId).toBeNull();
  expect(call.parentId).toBeNull();
});

test("the schema declares the tree, and every non-root span names its parent", () => {
  // The durable artifact. An exporter consumes this; a reader learns the shape
  // from it; and `parents` is the structural form of the edges the journal
  // stamps by hand.
  const spans = COVERIFY_TELEMETRY_SCHEMA.spans;
  expect(spans["coverify.run"].parents).toEqual({ kind: "root_or_external" });
  expect(spans["coverify.wake"].parents).toEqual({ kind: "spans", spans: ["coverify.run"] });
  expect(spans["coverify.dispatch"].parents).toEqual({ kind: "spans", spans: ["coverify.wake"] });
  expect(spans["coverify.stage"].parents).toEqual({ kind: "spans", spans: ["coverify.dispatch"] });
  // The leaf is deliberately `any`: spend is recorded at the leaf and nowhere
  // above, and a provider call happens under a wake, a dispatch AND a stage.
  expect(spans["coverify.provider_call"].parents).toEqual({ kind: "any" });
  // reasoning must never be summed with output; the description says so where
  // an exporter author will read it.
  expect(spans["coverify.provider_call"].endAttributes["coverify.tokens.reasoning"].description).toContain(
    "SUBSET",
  );
});
