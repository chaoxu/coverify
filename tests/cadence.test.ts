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

import { FIXTURE_ENVS, campaign, runCadence, stages } from "./cadence-fixture.ts";

afterEach(() => {
  for (const e of FIXTURE_ENVS) delete process.env[e];
});


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
