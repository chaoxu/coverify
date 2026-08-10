// The invariant that catches double-counted spend as a CLASS: turning the
// measurement extension on must not change what a campaign is measured to have
// cost. Two systems used to write a record for the same payment — the
// provider_call span's `role-call` leaf AND the completion / usage /
// gate-verdict record that referenced the call — so `coverify spend` counted
// every session-lane payment about twice with telemetry on, and once with it
// off. The rule now enforced: EXACTLY ONE WRITER PER BILLED PROVIDER CALL,
// whichever configuration is running.
//
// This suite drives real writers (the gate lane end to end, and a dispatched
// worker through cancel) rather than asserting on hand-built records: a writer
// that starts stamping tokens beside a leaf again must fail here.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { FIXTURE_ENVS, campaign } from "./cadence-fixture.ts";

const { JournalTelemetryContext } = await import("../src/telemetry/context.ts");
const { campaignSpend } = await import("../src/telemetry/spend.ts");
const { coordinatorTools } = await import("../src/coordinator-tools.ts");
const { buildModels, setTelemetrySink } = await import("../src/providers.ts");
const { GateStore } = await import("../src/gates.ts");
import type { Handle } from "../src/harness.ts";

const ROLE_ENVS = ["COVERIFY_MODEL_REASONER", "COVERIFY_MODEL_GATECRITIC"];

afterEach(() => {
  for (const e of [...FIXTURE_ENVS, ...ROLE_ENVS]) delete process.env[e];
  setTelemetrySink(NOOP_TELEMETRY_CONTEXT);
});

/** Every token the reader counted, per role, in one campaign. `reasoning` is
 *  deliberately excluded: it is a SUBSET of output, so adding it would count
 *  the same tokens twice inside the assertion meant to detect exactly that. */
function countedByRole(dir: string): Record<string, number> {
  const s = campaignSpend(dir);
  const out: Record<string, number> = {};
  for (const r of s.byRole) out[`${r.role} ${r.meter}`] = r.input + r.cacheRead + r.output;
  return out;
}

const total = (byRole: Record<string, number>) =>
  Object.values(byRole).reduce((a, b) => a + b, 0);

/**
 * One campaign: a gate critic and a dispatched reasoner, both answered by the
 * fixture's stub CLI (10 input / 1 output per call), then the worker cancelled
 * so the cancel path's completion writer runs too. Returns its directory —
 * read it BEFORE driving another, which re-points the fixture's state dir.
 */
async function driveCampaign(label: string, telemetry: boolean): Promise<string> {
  const { dir, store, calls } = campaign(label, ["IDEA PASS\nworth one worker", "The report."]);
  for (const e of ROLE_ENVS) process.env[e] = "codex-cli/stub@off";
  setTelemetrySink(telemetry ? new JournalTelemetryContext(store) : NOOP_TELEMETRY_CONTEXT);

  const handles = new Map<string, Handle>();
  let n = 0;
  const tools = coordinatorTools({
    dir,
    store,
    contract: "CONTRACT",
    models: await buildModels(),
    opts: {},
    sessionsRoot: path.join(dir, ".coverify", "sessions"),
    evidenceRelative: (p: string) => p,
    declaration: () => undefined,
    declare: () => {},
    nextId: () => ++n,
    wake: () => 3,
    handles,
    settledQueue: [],
    liveWorkers: () => 0,
    liveOnMechanism: () => 0,
    registerHandle: (h) => {
      handles.set(h.id, {
        ...h,
        promise: typeof h.promise === "function" ? h.promise() : h.promise,
      } as Handle);
    },
    harvestSettled: () => ({ total: 0 }),
    bumpActivity: () => {},
  });

  await tools.dispatchGateCritic.execute!("c1", {
    mechanism: "M",
    firstImplication: "the first nontrivial implication",
  });
  await handles.get("g001")!.promise;

  await tools.dispatchReasoner.execute!("c2", {
    mechanism: "M",
    task: "prove the lemma",
    context: "none",
    deliverable: "a proof",
    failedCheck: "no close prior route",
  });
  await handles.get("r002")!.promise;
  // The session is patched onto the handle a microtask after dispatch returns.
  await Promise.resolve();
  // Cancel AFTER the worker answered: the launcher's ordinary pause path, and
  // the second writer that used to restate a payment the leaf already carried.
  await tools.cancelWorker.execute!("c3", { id: "r002", reason: "fixture" });

  expect(calls()).toBe(2);
  setTelemetrySink(NOOP_TELEMETRY_CONTEXT);
  return dir;
}

test("counted spend is IDENTICAL with telemetry on and off", async () => {
  // The whole point. Before this, telemetry ON reported ~2x telemetry OFF on
  // every session-lane payment, and neither number was labelled as an estimate.
  const on = countedByRole(await driveCampaign("spend-on", true));
  const off = countedByRole(await driveCampaign("spend-off", false));

  // Two calls, 10 input + 1 output each: 22 tokens, whichever configuration ran.
  expect(total(off)).toBe(22);
  expect(total(on)).toBe(22);
  // Not merely the same total: the same tokens against the same roles. A leaf
  // that lost its parent edge would land in `orphaned-spend` and fail here even
  // though the total still balanced.
  expect(on).toEqual(off);
  expect(Object.keys(on).sort()).toEqual(["gate-critic codex-cli-jsonl", "reasoner codex-cli-jsonl"]);
}, 30_000);

test("a record that only REFERENCES a leafed call is not reported as unmeasurable", async () => {
  // The reader's half of the same rule. Once the verdict and the completion
  // stopped carrying tokens they looked, to `coverify spend`, like calls whose
  // usage nobody could measure — a phantom gap on every campaign written since,
  // in the very section that exists to keep real gaps visible. They are joined
  // to the leaf that holds the payment, so they are silent instead.
  const s = campaignSpend(await driveCampaign("spend-gaps", true));
  expect(s.excluded).toEqual([]);
  expect(s.unmetered).toEqual([]);
}, 30_000);

test("with telemetry on, the referencing records carry join keys and no tokens", async () => {
  // The mechanism behind the invariant above, pinned directly so a regression
  // says WHICH writer re-appeared rather than only that a total moved.
  const { dir, store } = campaign("spend-shape", ["IDEA PASS\nfine", "The report."]);
  for (const e of ROLE_ENVS) process.env[e] = "codex-cli/stub@off";
  setTelemetrySink(new JournalTelemetryContext(store));
  const handles = new Map<string, Handle>();
  let n = 0;
  const tools = coordinatorTools({
    dir,
    store,
    contract: "CONTRACT",
    models: await buildModels(),
    opts: {},
    sessionsRoot: path.join(dir, ".coverify", "sessions"),
    evidenceRelative: (p: string) => p,
    declaration: () => undefined,
    declare: () => {},
    nextId: () => ++n,
    wake: () => 5,
    handles,
    settledQueue: [],
    liveWorkers: () => 0,
    liveOnMechanism: () => 0,
    registerHandle: (h) => {
      handles.set(h.id, {
        ...h,
        promise: typeof h.promise === "function" ? h.promise() : h.promise,
      } as Handle);
    },
    harvestSettled: () => ({ total: 0 }),
    bumpActivity: () => {},
  });
  await tools.dispatchGateCritic.execute!("c1", { mechanism: "M", firstImplication: "an implication" });
  await handles.get("g001")!.promise;
  setTelemetrySink(NOOP_TELEMETRY_CONTEXT);

  const verdict = store.all().find((r) => r.kind === "gate-verdict")!;
  // The DECISION record: still fully identified, but not a second copy of the
  // payment. `dispatchId` is what joins it to the leaf that holds the tokens.
  expect(verdict.usage).toBeUndefined();
  expect(verdict.attempts).toBeUndefined();
  expect(verdict.requests).toBeUndefined();
  expect(verdict.dispatchId).toBe("g001");

  const leaves = store.all().filter((r) => r.kind === "role-call");
  expect(leaves).toHaveLength(1);
  // The gate lane used to have no parent span at all, so its leaf carried no
  // role, no wake and no dispatch id and bucketed as `orphaned-spend`.
  expect(leaves[0].role).toBe("gate-critic");
  expect(leaves[0].wake).toBe(5);
  expect(leaves[0].dispatchId).toBe("g001");
  expect((leaves[0].usage as { input: number }).input).toBe(10);
}, 30_000);

test("a single-shot role on a session backend writes one leaf, not two", async () => {
  // runRole used to open a provider_call span of its own AROUND a session whose
  // `ask` opens one too, so every API-provider single-shot role (the verifier
  // stages when they are not routed to a CLI) emitted the same tokens twice.
  // The CLI lane hid it: a CLI session had no span of its own at all.
  const { createHarnessRoleSession, runRole } = await import("../src/providers.ts");
  const dir = fs.mkdtempSync("/private/tmp/coverify-onecall-");
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# s\n");
  const store = new GateStore(dir);
  setTelemetrySink(new JournalTelemetryContext(store));

  const models = {
    getModel: () => ({ id: "fake-model", provider: "anthropic", api: "anthropic-messages" }),
    streamSimple: () => {
      const stream = (async function* () {
        yield { type: "done" };
      })() as AsyncGenerator<unknown> & { result: () => Promise<unknown> };
      stream.result = async () => ({
        role: "assistant",
        content: [{ type: "text", text: "VERDICT: PASS" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fake-model",
        usage: { input: 160, output: 20, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      return stream;
    },
  };
  const run = {
    contract: "c",
    charge: "c",
    prompt: "q",
    spec: { provider: "anthropic" as const, modelId: "fake-model", thinking: "off" as const },
    models: models as never,
  };
  await runRole(run);
  expect(store.all().filter((r) => r.kind === "role-call")).toHaveLength(1);

  // And a multi-turn session leafs each turn once: two turns at 160+20, so the
  // reader must see 360 in total and not the 720 two writers produced.
  const session = await createHarnessRoleSession(run, { sessionId: "two-turn", ephemeral: true });
  await session.ask("one");
  await session.ask("two");
  setTelemetrySink(NOOP_TELEMETRY_CONTEXT);
  const leaves = store.all().filter((r) => r.kind === "role-call");
  expect(leaves).toHaveLength(3);
  const counted = campaignSpend(dir).byRole.reduce((n, r) => n + r.input + r.cacheRead + r.output, 0);
  expect(counted).toBe(3 * 180);
});
