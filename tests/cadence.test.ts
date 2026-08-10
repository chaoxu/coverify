// The verification cadence, driven end to end. It is the most clause-dense
// code in the repo and was, until this file, entirely untested (issue #42):
// an intermediate refactor once disabled roll-up marking outright with tsc
// clean and every test green, because nothing here exercised the path.
//
// The assertion the issue originally asked for — that the completion carries
// `usageRollup` — is obsolete: the roll-up was DELETED (7bd75d5) rather than
// marked, two hours after the issue was filed. So these pin the invariant that
// REPLACED it: cadence cost is a GROUP BY dispatchId over stage leaves, each
// payment appearing exactly once.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { requestVerificationTool } = await import("../src/cadence.ts");
const { GateStore } = await import("../src/gates.ts");
const { buildModels } = await import("../src/providers.ts");

const VERIFIER_ENVS = [
  "COVERIFY_MODEL_AUDITOR",
  "COVERIFY_MODEL_CERTIFIER",
  "COVERIFY_MODEL_RECONSTRUCTOR",
  "COVERIFY_MODEL_COMPARATOR",
];

afterEach(() => {
  for (const e of [...VERIFIER_ENVS, "COVERIFY_CODEX_CMD", "COVERIFY_STATE_DIR"]) delete process.env[e];
});

/** A campaign with one candidate, and every verifier role pointed at a stub
 *  CLI that answers the stages in order. Each stub call reports 10 input / 1
 *  output tokens, so "counted exactly once" is checkable by arithmetic. */
function campaign(label: string, verdicts: string[]) {
  const dir = fs.mkdtempSync(`/private/tmp/coverify-cadence-${label}-`);
  fs.mkdirSync(path.join(dir, "EVIDENCE"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n\nA fixture target.\n");
  fs.writeFileSync(path.join(dir, "PROVED.md"), "");
  fs.writeFileSync(path.join(dir, "EVIDENCE", "cand.r1.md"), "# candidate\n\nA proof.\n");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`/private/tmp/coverify-cadstate-${label}-`);

  // Answers come from a sequence file, one per call, because the four stages
  // run through the same backend and must return different verdicts.
  // One FILE per answer, not one line: parseFirstLineVerdict requires the
  // verdict to be the whole first line, so a realistic reply keeps its prose
  // on the lines below and cannot be stored line-indexed.
  const seq = path.join(dir, "seq");
  fs.mkdirSync(seq, { recursive: true });
  verdicts.forEach((v, i) => fs.writeFileSync(path.join(seq, `${i + 1}.txt`), v));
  const counter = path.join(dir, "n.txt");
  const stub = path.join(dir, "stub.sh");
  fs.writeFileSync(
    stub,
    `#!/bin/sh\ncat > /dev/null\nn=$(cat ${counter} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${counter}\n` +
      `echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}'\n` +
      `cat ${seq}/$n.txt > "$1"\n`,
    { mode: 0o755 },
  );
  process.env.COVERIFY_CODEX_CMD = `${stub} {out}`;
  for (const e of VERIFIER_ENVS) process.env[e] = "codex-cli/stub@off";
  return { dir, store: new GateStore(dir), calls: () => Number(fs.readFileSync(counter, "utf8").trim()) };
}

/** Run one cadence to completion and hand back the journal it wrote. The id,
 *  wake and rebuttal are parameters because the carry-forward test runs a
 *  SECOND cadence over the same store: a re-attempt against a standing FAIL
 *  gets a fresh verification id and carries the rebuttal the contract
 *  requires. Only `hasHandle` is asked about an id, and only ever about the
 *  cadence's own (cadence.ts `cancelled`), so answering for this id is the
 *  whole of a live handle. */
async function runCadence(
  dir: string,
  store: InstanceType<typeof GateStore>,
  opts: { id?: string; wake?: number; rebuttalArtifact?: string } = {},
) {
  const { id = "v1", wake = 1, rebuttalArtifact } = opts;
  const models = await buildModels();
  let promise: (() => Promise<string>) | undefined;
  const tool = requestVerificationTool({
    dir,
    store,
    contract: "CONTRACT",
    models,
    evidenceRelative: (p: string) => (p.includes("..") ? undefined : p),
    declaration: () => undefined,
    mintVerificationId: () => id,
    wake: () => wake,
    hasHandle: (asked: string) => asked === id,
    liveCount: () => 0,
    registerHandle: (h) => {
      promise = h.promise;
    },
  });
  await tool.execute(`call-${id}`, {
    revision: "cand.r1.md",
    declaredDependencies: "none",
    keyIdeas: "the idea, stated at a high level",
    allowedSources: "standard references",
    ...(rebuttalArtifact === undefined ? {} : { rebuttalArtifact }),
  });
  if (!promise) throw new Error("cadence registered no handle");
  return promise();
}

const stages = (store: InstanceType<typeof GateStore>) =>
  store.all().filter((r) => ["audit", "bundle-cert", "reconstruction", "comparison"].includes(String(r.kind)));

test("a full cadence writes one decision per stage, all under one dispatchId", async () => {
  // Decision records carry NO spend: they say what was decided, and they are
  // written whether or not telemetry is on.
  const { dir, store, calls } = campaign("full", [
    "VERDICT: PASS\nthe candidate holds",
    "VERDICT: PASS\nthe bundle leaks nothing",
    "A reconstruction of the argument.",
    "VERDICT: PASS\nthe reconstruction matches",
  ]);
  await runCadence(dir, store);

  const s = stages(store);
  expect(s.map((r) => r.kind).sort()).toEqual(["audit", "bundle-cert", "comparison", "reconstruction"]);
  expect(new Set(s.map((r) => r.dispatchId))).toEqual(new Set(["v1"]));
  expect(calls()).toBe(4);
  for (const r of s) expect(r.usage).toBeUndefined();
  // Telemetry is off here, so nothing counted the tokens — and the verdicts
  // still landed. That is the separation the extension exists to have.
  expect(store.all().filter((r) => r.kind === "role-call")).toHaveLength(0);
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
  const { JournalTelemetryContext } = await import("../src/telemetry/context.ts");
  const { setTelemetrySink } = await import("../src/providers.ts");
  const { NOOP_TELEMETRY_CONTEXT } = await import("@earendil-works/pi-telemetry");
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

test("an audit FAIL exits before the second stage runs", async () => {
  // "A substantive FAIL from any stage stands" — the cadence must not spend
  // certifier, reconstructor and comparator tokens after the audit refuses.
  const { dir, store, calls } = campaign("auditfail", ["VERDICT: FAIL\nstep 3 does not follow"]);
  await runCadence(dir, store);

  const s = stages(store);
  expect(s.map((r) => r.kind)).toEqual(["audit"]);
  expect(s[0].verdict).toBe("FAIL");
  expect(calls()).toBe(1);
});

test("a bundle-cert FAIL exits before the reconstruction is paid for", async () => {
  // The reconstruction is the most expensive stage in the cadence. A leaking
  // bundle must be refused before it is bought.
  const { dir, store, calls } = campaign("certfail", [
    "VERDICT: PASS\nthe candidate holds",
    "VERDICT: FAIL\nthe key ideas restate the proof",
  ]);
  await runCadence(dir, store);

  expect(stages(store).map((r) => r.kind)).toEqual(["audit", "bundle-cert"]);
  expect(calls()).toBe(2);
});

test("a re-run on byte-identical inputs carries every reusable stage forward", async () => {
  // Reuse is keyed on the content hash of every input the stage saw
  // (priorReusableRecord, requireStranded), so on an unchanged candidate the
  // audit, the bundle certification AND the blind reconstruction all carry
  // forward and only the comparison is re-bought. That is the economic point
  // of the carry-forward rule, and it is the strongest claim this cadence
  // makes about not paying twice for the same verifier response.
  const { dir, store, calls } = campaign("carry", [
    "VERDICT: PASS\nholds",
    "VERDICT: PASS\nno leak",
    "A reconstruction of the argument.",
    "VERDICT: FAIL\nthe conclusions differ",
    // Second cadence: the comparison, and nothing else.
    "VERDICT: PASS\nthey match now",
  ]);
  await runCadence(dir, store);
  const afterFirst = calls();
  expect(afterFirst).toBe(4);

  // A FAIL stands against the exact bytes, so the re-attempt carries the
  // rebuttal the contract requires.
  fs.writeFileSync(path.join(dir, "EVIDENCE", "rebuttal.md"), "# rebuttal\n\nWhy the comparison erred.\n");
  await runCadence(dir, store, { id: "v2", wake: 2, rebuttalArtifact: "rebuttal.md" });

  // ONE more provider call, not four: only the comparison was re-bought.
  expect(calls() - afterFirst).toBe(1);
  // Each carried record is content-bound to the record it reuses rather than
  // being a fresh purchase, and says so on its face.
  const carried = store.all().filter((r) => r.carriedForwardFrom !== undefined);
  expect(carried.map((r) => r.kind).sort()).toEqual(["audit", "bundle-cert", "reconstruction"]);
  for (const r of carried) expect(r.artifactHash).toBeDefined();
  // The second cadence's comparison is a real purchase under its own id.
  const comparisons = store.all().filter((r) => r.kind === "comparison");
  expect(comparisons).toHaveLength(2);
  expect(comparisons[1].dispatchId).toBe("v2");
  expect(comparisons[1].carriedForwardFrom).toBeUndefined();
});
