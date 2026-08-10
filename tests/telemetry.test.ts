// The measurement extension. Two properties matter: spans are the recording
// path for spend, and the whole folder is removable without touching what a
// campaign concludes.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { FIXTURE_ENVS, campaign, runCadence } from "./cadence-fixture.ts";
import { recordFixture } from "./helpers.ts";

const { COVERIFY_TELEMETRY_SCHEMA } = await import("../src/telemetry/schema.ts");
const { JournalTelemetryContext } = await import("../src/telemetry/context.ts");
const { runRole, setTelemetrySink, telemetrySink } = await import("../src/providers.ts");
const { GateStore } = await import("../src/gates.ts");

const stubDir = fs.mkdtempSync("/private/tmp/coverify-telemetry-");
afterEach(() => {
  for (const e of FIXTURE_ENVS) delete process.env[e];
  delete process.env.COVERIFY_CODEX_CMD;
  setTelemetrySink(NOOP_TELEMETRY_CONTEXT);
});

/** A stubbed codex call, so a span carries real usage. */
async function callStub(input: number, cached: number, parent?: unknown) {
  const stub = path.join(stubDir, `t${input}-${cached}.sh`);
  fs.writeFileSync(
    stub,
    `#!/bin/sh\necho '{"type":"turn.completed","usage":{"input_tokens":${input},` +
      `"cached_input_tokens":${cached},"output_tokens":7,"reasoning_output_tokens":3}}'\n` +
      `printf 'VERDICT: PASS' > "$1"\n`,
    { mode: 0o755 },
  );
  process.env.COVERIFY_CODEX_CMD = `${stub} {out}`;
  return runRole(
    {
      contract: "c",
      charge: "c",
      prompt: "q",
      spec: { provider: "codex-cli", modelId: "stub", thinking: "off" },
      models: undefined as never,
    },
    undefined,
    parent as never,
  );
}

test("core defaults to NOOP, so the extension is genuinely optional", async () => {
  // Deleting src/telemetry/ must leave a harness that still runs. Core holds
  // only the TYPE from the package (erased at runtime) and this default.
  expect(telemetrySink()).toBe(NOOP_TELEMETRY_CONTEXT);
  let ran = false;
  const out = await telemetrySink().startSpan({ name: "coverify.provider_call" }, async () => {
    ran = true;
    return 42;
  });
  // NOOP still runs the callback and returns its value: observability must
  // never change whether the operation happens.
  expect(ran).toBe(true);
  expect(out).toBe(42);
});

test("a billed call becomes a role-call leaf in the journal", async () => {
  const dir = recordFixture("telemetry", []);
  const store = new GateStore(dir);
  setTelemetrySink(new JournalTelemetryContext(store));
  await callStub(1000, 900);

  const leaves = store.all().filter((r) => r.kind === "role-call");
  expect(leaves).toHaveLength(1);
  const u = leaves[0].usage as Record<string, number | string>;
  // `input` is the uncached part on every lane: 1000 presented, 900 cached.
  expect(u.input).toBe(100);
  expect(u.cacheRead).toBe(900);
  expect(u.output).toBe(7);
  expect(u.reasoning).toBe(3);
  expect(u.meter).toBe("codex-cli-jsonl");
  expect(leaves[0].modelSpec).toBe("codex-cli/stub@off");
  // The codex lane reports no cache writes; absent ≠ zero.
  expect(u.cacheWrite).toBeUndefined();
});

test("parent edges come off the span tree, not from a copied field", async () => {
  // The reason to adopt a span contract: dispatchId and wake used to be copied
  // onto each record by hand, and three reviews found gaps in the copying.
  const dir = recordFixture("telemetry-tree", []);
  const store = new GateStore(dir);
  const ctx = new JournalTelemetryContext(store);
  await ctx.startSpan({ name: "coverify.wake", attributes: { "coverify.wake": 7 } }, async (wake) =>
    wake.startSpan(
      {
        name: "coverify.dispatch",
        attributes: { "coverify.dispatch_id": "r001", "coverify.role": "reasoner" },
      },
      async (dispatch) =>
        dispatch.startSpan(
          {
            name: "coverify.stage",
            attributes: { "coverify.stage": "audit", "coverify.revision": "c.md" },
          },
          async (stage) => callStub(10, 0, stage),
        ),
    ),
  );
  const leaf = store.all().find((r) => r.kind === "role-call")!;
  // Every edge inherited from an ancestor span; none was passed to the call
  // site that wrote the record.
  expect(leaf.dispatchId).toBe("r001");
  expect(leaf.wake).toBe(7);
  expect(leaf.role).toBe("reasoner");
  expect(leaf.stage).toBe("audit");
  expect(leaf.revision).toBe("c.md");
});

test("only provider calls persist; wake and dispatch spans carry edges only", async () => {
  // A record for a wake or a dispatch would duplicate campaign state the
  // harness already writes. Spans above the leaf exist to carry the edges.
  const dir = recordFixture("telemetry-leafonly", []);
  const store = new GateStore(dir);
  const ctx = new JournalTelemetryContext(store);
  await ctx.startSpan({ name: "coverify.wake", attributes: { "coverify.wake": 1 } }, async (w) =>
    w.startSpan({ name: "coverify.dispatch", attributes: { "coverify.dispatch_id": "r9" } }, async () => "done"),
  );
  expect(store.all().filter((r) => r.kind === "role-call")).toHaveLength(0);
});

test("the schema declares the tree, and every non-root span names its parent", () => {
  const spans = COVERIFY_TELEMETRY_SCHEMA.spans;
  expect(spans["coverify.run"].parents).toEqual({ kind: "root_or_external" });
  expect(spans["coverify.wake"].parents).toEqual({ kind: "spans", spans: ["coverify.run"] });
  expect(spans["coverify.dispatch"].parents).toEqual({ kind: "spans", spans: ["coverify.wake"] });
  expect(spans["coverify.stage"].parents).toEqual({ kind: "spans", spans: ["coverify.dispatch"] });
  // The leaf is deliberately `any`: a provider call happens under a wake, a
  // dispatch AND a stage, and spend is recorded there and nowhere above.
  expect(spans["coverify.provider_call"].parents).toEqual({ kind: "any" });
  expect(spans["coverify.provider_call"].endAttributes["coverify.tokens.reasoning"].description).toContain(
    "SUBSET",
  );
});

test("the in-memory reference adapter still works for exporter authors", async () => {
  // pi-telemetry ships this; an OTel adapter is a third context, not a rewrite.
  const recorder = new InMemoryTelemetryContext();
  setTelemetrySink(recorder);
  await callStub(20, 5);
  const call = recorder.getSpans().find((s) => s.name === "coverify.provider_call")!;
  expect(call.attributes["coverify.tokens.input"]).toBe(15);
  expect(call.status.status).toBe("ok");
});

test("a session accepts a telemetry parent, and refuses a CLI provider outright", async () => {
  // NOT a test that the session lane emits. Driving a real pi session needs a
  // real model, so the lane that carries the coordinator and every dispatched
  // worker is covered by the cadence and librarian suites and by smoke runs,
  // not here. What this pins is narrower and still worth pinning: the `parent`
  // option exists and is typed, so a call site can pass its span; and a CLI
  // provider is rejected for sessions rather than silently degrading.
  const dir = recordFixture("telemetry-session", []);
  const store = new GateStore(dir);
  const recorder = new InMemoryTelemetryContext();
  const { createHarnessRoleSession } = await import("../src/providers.ts");
  const { buildModels } = await import("../src/providers.ts");

  const session = await createHarnessRoleSession(
    {
      contract: "c",
      charge: "c",
      spec: { provider: "codex-cli", modelId: "stub", thinking: "off" },
      models: await buildModels(),
    },
    { sessionId: "probe", ephemeral: true, parent: recorder },
  ).catch((e) => e as Error);

  expect(session).toBeInstanceOf(Error);
  expect(String(session)).toContain("single-shot verdict roles only");
  // A refused session bought nothing, so it must record nothing — on either
  // the journal or the span recorder it was handed.
  expect(store.all()).toHaveLength(0);
  expect(recorder.getSpans()).toHaveLength(0);
});

test("with telemetry on, the same cadence's spend lands on leaves under that dispatch", async () => {
  // Cadence cost is GROUP BY dispatchId over role-call leaves. Four calls at
  // 10 input each: 40, counted exactly once, and attributable to the stage
  // that spent it without any stage record carrying a token.
  const { dir, store } = campaign("full-telemetry", [
    "VERDICT: PASS\nholds",
    "VERDICT: PASS\nno leak",
    "A reconstruction.",
    "VERDICT: PASS\nmatches",
  ]);
  setTelemetrySink(new JournalTelemetryContext(store));
  try {
    await runCadence(dir, store);
  } finally {
    setTelemetrySink(NOOP_TELEMETRY_CONTEXT);
  }
  const leaves = store.all().filter((r) => r.kind === "role-call");
  expect(leaves).toHaveLength(4);
  expect(leaves.reduce((n, r) => n + ((r.usage as { input?: number })?.input ?? 0), 0)).toBe(40);
  // Every leaf inherited the dispatch and the stage from its ancestors.
  expect(new Set(leaves.map((r) => r.dispatchId))).toEqual(new Set(["v1"]));
  expect(new Set(leaves.map((r) => r.stage)).size).toBe(4);
});
