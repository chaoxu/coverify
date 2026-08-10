// Campaign-logic enforcement: verdict recency, idea-gate re-arming, and the
// FAILED.md check. Added after the round-4 review found each of these
// reachable by an ordinary coordinator, not by deliberate evasion.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const {
  GateStore,
  checkDispatch,
  checkPromotion,
  statementHash,
  priorReusableRecord,
  promotionsNeedingRetraction,
  retractionClosure,
  undeliveredCompletions,
} = await import("../src/gates.ts");
const { sha256File, sha256Text, danglingCitations } = await import("../src/campaign.ts");

function campaign(label: string) {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coverify-gates-${label}-`);
  fs.mkdirSync(path.join(dir, "EVIDENCE"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n");
  fs.writeFileSync(path.join(dir, "PROVED.md"), "");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`${os.tmpdir()}/coverify-state-${label}-`);
  return { dir, store: new GateStore(dir) };
}

const base = { mechanism: "m1", task: "t", context: "c", deliverable: "d" };

describe("FAILED.md check", () => {
  const { store } = campaign("failed");
  const check = (failedCheck: string) =>
    checkDispatch(store, "reasoner", { ...base, failedCheck } as any, undefined, 0, 0).allowed;
  test("accepts a real check", () => expect(check("no close prior route")).toBe(true));
  test("accepts a real differentiation", () =>
    expect(check("closest prior route is R7; this differs materially because it drops the acyclicity assumption")).toBe(
      true,
    ));
  test("refuses the parameter's own placeholder", () =>
    expect(check("closest prior route is X; this differs materially because ...")).toBe(false));
});

describe("idea gate is re-armable", () => {
  const { store } = campaign("idea");
  const dispatch = () =>
    checkDispatch(store, "reasoner", { ...base, failedCheck: "no close prior route" } as any, undefined, 1, 1)
      .allowed;
  test("a second concurrent worker needs IDEA PASS", () => expect(dispatch()).toBe(false));
  test("IDEA PASS opens the wave", () => {
    store.append({ kind: "gate-verdict", mechanism: "m1", verdict: "IDEA PASS" });
    expect(dispatch()).toBe(true);
  });
  test("a later IDEA FAIL closes it again", () => {
    store.append({ kind: "gate-verdict", mechanism: "m1", verdict: "IDEA FAIL" });
    expect(dispatch()).toBe(false);
  });
});

describe("promotion follows the latest verdict", () => {
  const { dir, store } = campaign("promote");
  const rel = "cand.md";
  const candidate = path.join(dir, "EVIDENCE", rel);
  fs.writeFileSync(candidate, "# candidate proof\n");
  const hashes = () => ({ candidateHash: sha256File(candidate), statementHash: statementHash(dir) });
  test("both stages PASS ⇒ promotable", () => {
    store.append({ kind: "audit", revision: rel, verdict: "PASS", ...hashes() });
    store.append({ kind: "comparison", revision: rel, verdict: "PASS", ...hashes() });
    expect(checkPromotion(store, dir, rel).allowed).toBe(true);
  });
  test("a later FAIL on the same content revokes it", () => {
    store.append({ kind: "comparison", revision: rel, verdict: "FAIL", ...hashes() });
    expect(checkPromotion(store, dir, rel).allowed).toBe(false);
  });
  test("a fresh PASS after the FAIL restores it", () => {
    store.append({ kind: "comparison", revision: rel, verdict: "PASS", ...hashes() });
    expect(checkPromotion(store, dir, rel).allowed).toBe(true);
  });
  test("editing the candidate invalidates promotion", () => {
    fs.appendFileSync(candidate, "\nedit\n");
    expect(checkPromotion(store, dir, rel).allowed).toBe(false);
  });
});

describe("revision-impact rules the launcher states", () => {
  test("a FAIL follows the content, not the filename", () => {
    // "A substantive FAIL from any stage stands against the revision that
    // received it" — copying identical bytes to a new name is that revision.
    const { dir, store } = campaign("failinherit");
    const a = path.join(dir, "EVIDENCE", "cand.r1.md");
    fs.writeFileSync(a, "# candidate\n\nsame bytes\n");
    const hashes = { candidateHash: sha256File(a), statementHash: statementHash(dir) };
    store.append({ kind: "comparison", revision: "cand.r1.md", verdict: "FAIL", ...hashes });
    const b = path.join(dir, "EVIDENCE", "cand-copy.md");
    fs.copyFileSync(a, b);
    const priorFailFor = (rev: string, file: string) =>
      store.all().some(
        (e) =>
          (e.kind === "audit" || e.kind === "comparison") &&
          e.candidateHash === sha256File(file) &&
          e.statementHash === statementHash(dir) &&
          e.verdict === "FAIL",
      );
    expect(priorFailFor("cand.r1.md", a)).toBe(true);
    expect(priorFailFor("cand-copy.md", b)).toBe(true); // the rename must not clear it
  });

  test("a reconstruction is reusable only for the identical candidate", () => {
    // The contract: a repair invalidates both stages and must never reuse a
    // verifier response that influenced it. Only a re-run on identical bytes
    // (protocol/infrastructure failure) may reuse the reconstruction.
    const { dir, store } = campaign("carryfwd");
    const r1 = path.join(dir, "EVIDENCE", "d.r1.md");
    fs.writeFileSync(r1, "# proof v1\n");
    const art = path.join(dir, "EVIDENCE", "recon.md");
    fs.writeFileSync(art, "# reconstruction\n");
    const common = {
      statementHash: statementHash(dir),
      bundleHash: sha256Text("bundle"),
      provedHash: sha256Text("proved"),
      artifact: path.relative(dir, art),
      artifactHash: sha256File(art),
    };
    store.append({ kind: "reconstruction", revision: "d.r1.md", candidateHash: sha256File(r1), ...common });
    const reusableFor = (file: string) =>
      priorReusableRecord(
        store,
        dir,
        "reconstruction",
        {
          candidateHash: sha256File(file),
          statementHash: common.statementHash,
          bundleHash: common.bundleHash,
          provedHash: common.provedHash,
        },
        { requireStranded: false },
      ) !== undefined;
    expect(reusableFor(r1)).toBe(true); // identical candidate: a legitimate re-run
    const r2 = path.join(dir, "EVIDENCE", "d.r2.md");
    fs.writeFileSync(r2, "# proof v2, hypothesis added\n");
    expect(reusableFor(r2)).toBe(false); // repaired candidate: must regenerate
  });

  // Shared fixture for the priorReusableRecord tests: a candidate, a saved stage
  // artifact, the stage record fields binding them, and a stranded dispatch.
  const stageFixture = (label: string, artifactText: string) => {
    const { dir, store } = campaign(label);
    const cand = path.join(dir, "EVIDENCE", "d.r1.md");
    fs.writeFileSync(cand, "# proof v1\n");
    const art = path.join(dir, "EVIDENCE", "audits", "d.r1.stage.r1.md");
    fs.mkdirSync(path.dirname(art), { recursive: true });
    fs.writeFileSync(art, artifactText);
    store.append({ kind: "dispatch", id: "v001", role: "verification", mechanism: "verification:d.r1.md", task: "d" });
    const inputs = { candidateHash: sha256File(cand), statementHash: statementHash(dir) };
    const record = {
      revision: "d.r1.md",
      ...inputs,
      dispatchId: "v001",
      artifact: path.relative(dir, art),
      artifactHash: sha256File(art),
    };
    return { dir, store, art, inputs, record };
  };

  test("a stranded audit PASS is reusable only for a byte-identical re-run", () => {
    // Restart-lost cadence (campaign 2026-08-01, v033): audit PASS recorded,
    // process died before stage 2, fresh request re-paid every stage. The
    // contract's byte-identical re-run clause lets priorReusableRecord carry the
    // PASS forward — keyed on every stage input, content-bound to the
    // artifact, and only while the PASS's cadence is stranded (dispatched,
    // never completed).
    const { dir, store, record } = stageFixture("stagereuse", "VERDICT: PASS\n");
    const inputs = { ...record, provedHash: sha256Text("proved"), dependenciesHash: sha256Text("deps") };
    store.append({ kind: "audit", verdict: "PASS", ...inputs });
    const lookup = { candidateHash: inputs.candidateHash, statementHash: inputs.statementHash,
      provedHash: inputs.provedHash, dependenciesHash: inputs.dependenciesHash };
    expect(priorReusableRecord(store, dir, "audit", lookup, { requireStranded: true })?.revision).toBe("d.r1.md");
    // Any changed input misses: a repaired candidate, new promotions, edited deps.
    const changed = (patch: Record<string, string>) =>
      priorReusableRecord(store, dir, "audit", { ...lookup, ...patch }, { requireStranded: true });
    expect(changed({ candidateHash: sha256Text("v2") })).toBeUndefined();
    expect(changed({ provedHash: sha256Text("more") })).toBeUndefined();
    // Once the cadence completes, it is no longer an infrastructure failure:
    // a re-request after a finished run (rebuttal challenge, duplicate ask)
    // owes fresh scrutiny at every stage.
    store.append({ kind: "completion", id: "v001" });
    expect(priorReusableRecord(store, dir, "audit", lookup, { requireStranded: true })).toBeUndefined();
  });

  test("an edited artifact or missing dispatch id blocks stage carry-forward", () => {
    const { dir, store, art, inputs, record } = stageFixture("stagereuse-artifact", "VERDICT: PASS\n");
    // A record without a cadence id (pre-dispatchId history) is never reused.
    store.append({ kind: "audit", verdict: "PASS", ...record, dispatchId: undefined });
    expect(priorReusableRecord(store, dir, "audit", inputs, { requireStranded: true })).toBeUndefined();
    store.append({ kind: "audit", verdict: "PASS", ...record });
    expect(priorReusableRecord(store, dir, "audit", inputs, { requireStranded: true })?.dispatchId).toBe("v001");
    // An edited artifact is no longer the verified response.
    fs.writeFileSync(art, "VERDICT: PASS (edited later)\n");
    expect(priorReusableRecord(store, dir, "audit", inputs, { requireStranded: true })).toBeUndefined();
  });

  test("a FAIL or verdict-less stage record is never carried forward", () => {
    const { dir, store, record } = stageFixture("stagereuse-fail", "VERDICT: FAIL\n");
    const inputs = { ...record, bundleHash: sha256Text("bundle") };
    store.append({ kind: "bundle-cert", verdict: "FAIL", ...inputs });
    store.append({ kind: "bundle-cert", verdict: "UNPARSEABLE", ...inputs });
    const lookup = { candidateHash: inputs.candidateHash, statementHash: inputs.statementHash,
      bundleHash: inputs.bundleHash };
    expect(priorReusableRecord(store, dir, "bundle-cert", lookup, { requireStranded: true })).toBeUndefined();
  });
});

describe("mirror-based gate-history recovery", () => {
  test("COVERIFY_ADOPT rebuilds gate history from the journal mirror, taint-marked", () => {
    const { dir, store } = campaign("adopt-recover");
    store.append({ kind: "comparison", revision: "d.r1.md", verdict: "FAIL", candidateHash: "x" });
    store.event({ kind: "note", note: "user message: prioritize the algebraic route" });
    fs.rmSync(process.env.COVERIFY_STATE_DIR!, { recursive: true, force: true });
    process.env.COVERIFY_ADOPT = "1";
    try {
      const rebuilt = new GateStore(dir);
      // The recorded FAIL survives the loss of the authoritative log...
      expect(rebuilt.all().some((e) => e.kind === "comparison" && e.verdict === "FAIL")).toBe(true);
      // ...as does replayable user guidance (an event, mirrored verbatim)...
      expect(
        rebuilt.all().some((e) => e.kind === "note" && String(e.note).startsWith("user message: ")),
      ).toBe(true);
      // ...and the lower-trust provenance is on the ledger forever.
      expect(rebuilt.all().some((e) => typeof e.reconstructedFromMirror === "number")).toBe(true);
    } finally {
      delete process.env.COVERIFY_ADOPT;
    }
  });

  test("without COVERIFY_ADOPT, lost gate history still refuses to run", () => {
    const { dir, store } = campaign("adopt-refuse");
    store.append({ kind: "statement", hash: "h", why: "w" });
    fs.rmSync(process.env.COVERIFY_STATE_DIR!, { recursive: true, force: true });
    expect(() => new GateStore(dir)).toThrow(/no gate history/);
  });
});

describe("delivery is durable, not one-shot", () => {
  test("a completion stays pending until a delivery record exists", () => {
    // Persistence and delivery are separate: a wake that fails after
    // harvesting must not consume the only chance to show a report.
    const { dir, store } = campaign("delivery");
    fs.mkdirSync(path.join(dir, "EVIDENCE", "r001"), { recursive: true });
    const report = path.join(dir, "EVIDENCE", "r001", "report.r1.md");
    fs.writeFileSync(report, "# findings\n");
    store.append({ kind: "dispatch", id: "r001", role: "reasoner", mechanism: "route-A", task: "t" });
    store.append({ kind: "completion", id: "r001", report: path.relative(dir, report) });

    // The REAL query, not a local reimplementation. This test used to define
    // its own `undelivered()` and assert against that, so deleting the
    // production rule left it green — it covered nothing. Extracting
    // undeliveredCompletions() out of the harness closure is what made it
    // reachable from here.
    const ids = () => undeliveredCompletions(store, dir).map((c) => c.id);
    expect(ids()).toEqual(["r001"]); // turn failed: still pending
    expect(ids()).toEqual(["r001"]); // and still pending on the next wake
    store.append({ kind: "delivery", ids: ["r001"] });
    expect(ids()).toEqual([]); // shown once, not re-offered forever

    // It renders the report, and names the mechanism from the dispatch record
    // — the part a bare id list never checked.
    store.append({ kind: "completion", id: "r002", report: path.relative(dir, report) });
    store.append({ kind: "dispatch", id: "r002", role: "reasoner", mechanism: "route-B", task: "t" });
    const [shown] = undeliveredCompletions(store, dir);
    expect(shown.mechanism).toBe("route-B");
    expect(shown.section).toContain("# findings");
  });

  test("a report edited after completion is delivered with a loud taint", () => {
    // Hash-bound like every other trusted artifact: the bytes delivered must
    // be provably the bytes the worker returned, or the coordinator is told.
    const { dir, store } = campaign("tainted");
    fs.mkdirSync(path.join(dir, "EVIDENCE", "r001"), { recursive: true });
    const report = path.join(dir, "EVIDENCE", "r001", "report.r1.md");
    fs.writeFileSync(report, "# original\n");
    store.append({ kind: "dispatch", id: "r001", role: "reasoner", mechanism: "m", task: "t" });
    store.append({
      kind: "completion",
      id: "r001",
      report: path.relative(dir, report),
      reportSha256: sha256Text("# original\n"),
    });
    expect(undeliveredCompletions(store, dir)[0].section).not.toContain("WARNING");
    fs.writeFileSync(report, "# tampered\n");
    expect(undeliveredCompletions(store, dir)[0].section).toContain("no longer matches the hash");
  });

  test("a cancelled agent is not re-offered as an undelivered report", () => {
    // Calls the real function. The previous version re-implemented the filter
    // over records it had just appended, so deleting the `cancelled` guard in
    // gates.ts left the whole suite green — and its completion carried no
    // `report`, so it would have been dropped for the wrong reason anyway.
    const { dir, store } = campaign("delivery-cancel");
    const report = path.join(dir, "EVIDENCE", "r002.md");
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, "# a real report\n");
    store.append({ kind: "dispatch", id: "r002", role: "reasoner", mechanism: "m", task: "t" });
    store.append({
      kind: "completion",
      id: "r002",
      cancelled: true,
      reason: "struggle",
      report: path.relative(dir, report),
      reportHash: sha256File(report),
    });
    expect(undeliveredCompletions(store, dir)).toEqual([]);

    // Control: the identical completion WITHOUT the cancel flag is offered, so
    // the assertion above is about `cancelled` and not about a fixture that
    // fails to produce any pending report at all.
    store.append({ kind: "dispatch", id: "r003", role: "reasoner", mechanism: "m", task: "t" });
    store.append({
      kind: "completion",
      id: "r003",
      report: path.relative(dir, report),
      reportHash: sha256File(report),
    });
    expect(undeliveredCompletions(store, dir).map((c) => c.id)).toEqual(["r003"]);
  });
});

describe("bookkeeping the harness should own", () => {
  test("mechanism identity survives retyping", () => {
    // The same mechanism written with different spacing or capitalisation must
    // not evade the wave gate, nor discard an IDEA PASS already paid for.
    const { store } = campaign("mechid");
    store.append({ kind: "gate-verdict", mechanism: "Spectral  Bound", verdict: "IDEA PASS" });
    const dispatch = (mechanism: string) =>
      checkDispatch(
        store,
        "reasoner",
        { mechanism, task: "t", context: "c", deliverable: "d", failedCheck: "no close prior route" } as any,
        undefined,
        1,
        1,
      ).allowed;
    expect(dispatch("Spectral  Bound")).toBe(true);
    expect(dispatch("spectral bound")).toBe(true); // same mechanism, retyped
    expect(dispatch(" spectral   BOUND ")).toBe(true);
    expect(dispatch("a genuinely different mechanism")).toBe(false);
  });

  test("a promoted claim contradicted by a later FAIL is surfaced", () => {
    const { dir, store } = campaign("retract");
    const f = path.join(dir, "EVIDENCE", "thm.r1.md");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "# theorem\n");
    const h = { candidateHash: sha256File(f), statementHash: statementHash(dir) };
    store.append({ kind: "promotion", revision: "thm.r1.md", ...h });
    expect(promotionsNeedingRetraction(store)).toEqual([]);
    store.append({ kind: "comparison", revision: "thm.r1.md", verdict: "FAIL", ...h });
    const needed = promotionsNeedingRetraction(store);
    expect(needed.length).toBe(1);
    expect(needed[0].revision).toBe("thm.r1.md");
  });

  test("a ledger citing a missing artifact is caught", () => {
    const { dir } = campaign("citations");
    fs.mkdirSync(path.join(dir, "EVIDENCE", "r001"), { recursive: true });
    fs.writeFileSync(path.join(dir, "EVIDENCE", "r001", "report.r1.md"), "# real\n");
    fs.writeFileSync(
      path.join(dir, "FAILED.md"),
      "# FAILED\n\n- route A closed, see EVIDENCE/r001/report.r1.md\n" +
        "- route B closed, see EVIDENCE/r009/report.r1.md\n",
    );
    const dangling = danglingCitations(dir);
    expect(dangling.length).toBe(1);
    expect(dangling[0].citation).toBe("EVIDENCE/r009/report.r1.md");
  });
});

describe("retraction closure walks premises edges", () => {
  const { store } = campaign("closure");
  test("a retracted premise enumerates its transitive dependents", () => {
    store.append({ kind: "promotion", revision: "a.md", candidateHash: "h-a" });
    store.append({ kind: "promotion", revision: "b.md", candidateHash: "h-b", premises: ["a.md"] });
    store.append({ kind: "promotion", revision: "c.md", candidateHash: "h-c", premises: ["b.md"] });
    store.append({ kind: "promotion", revision: "solo.md", candidateHash: "h-s" });
    store.append({ kind: "audit", revision: "a.md", verdict: "FAIL", candidateHash: "h-a" });
    const rc = retractionClosure(store);
    expect(rc.length).toBe(1);
    expect(rc[0].revision).toBe("a.md");
    expect(rc[0].dependents.sort()).toEqual(["b.md", "c.md"]);
  });
  test("a promotion without premises has an empty closure", () => {
    store.append({ kind: "audit", revision: "solo.md", verdict: "FAIL", candidateHash: "h-s" });
    const solo = retractionClosure(store).find((r) => r.revision === "solo.md")!;
    expect(solo.dependents).toEqual([]);
  });
  test("premise matching is case-insensitive like revision identity", () => {
    store.append({ kind: "promotion", revision: "D.md", candidateHash: "h-d", premises: ["A.MD"] });
    const a = retractionClosure(store).find((r) => r.revision === "a.md")!;
    expect(a.dependents).toContain("D.md");
  });
});
