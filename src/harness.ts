import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  appendJournal,
  newEvidencePath,
  readLedger,
  resumeBundle,
  sha256File,
  sha256Text,
} from "./campaign.js";
import {
  acceptedStatementHash,
  checkPromotion,
  checkWorkerDispatch,
  GateStore,
  parseFirstLineVerdict,
  recordGateVerdict,
  statementHash,
  type WorkerPacket,
} from "./gates.js";
import { loadLauncherContract } from "./launcher.js";
import { buildModels, CHARGES, runRole, type WriteScope } from "./roles.js";

export interface CampaignOptions {
  campaignDir: string;
  modelId: string;
  /** User-set limit only; the launcher forbids a fixed harness ceiling. */
  userAgentLimit?: number;
  /** Stop waking the coordinator after this many wakes (user runtime limit). */
  maxWakes?: number;
}

interface Handle {
  id: string;
  mechanism: string;
  promise: Promise<string>;
}

/** Consecutive wakes with no dispatch, no verification, and no declaration
 *  before the harness pauses operationally to stop runaway spend. This is an
 *  operational pause (campaign stays authorized), never a completion. */
const NOOP_WAKE_PAUSE = 3;

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function harnessRevision(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: path.dirname(new URL(import.meta.url).pathname) })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * The harness event loop — the only persistent process. Completions wake an
 * ephemeral coordinator with a rebuilt minimal bundle; there is no resident
 * model conversation and no polling.
 */
export async function runCampaign(opts: CampaignOptions): Promise<string> {
  const dir = path.resolve(opts.campaignDir);
  const contract = loadLauncherContract();
  const models = buildModels();
  const store = new GateStore(dir);

  // Version stamp at every run start: attributes this run to an exact
  // (harness, contract) pair. Harness audit metadata — launcher-permitted.
  appendJournal(dir, {
    kind: "note",
    note: "run-start",
    harnessRev: harnessRevision(),
    launcherSha256: sha256Text(contract),
  });

  // Statement freeze: hard-stop if STATEMENT.md changed without a recorded
  // user amendment ("only an explicit user amendment may replace it").
  const accepted = acceptedStatementHash(store);
  if (accepted !== undefined && accepted !== statementHash(dir)) {
    throw new Error(
      "STATEMENT.md differs from the last user-accepted revision. If this is an explicit user " +
        "amendment, run 'coverify amend' to accept it (starting a new statement revision and " +
        "invalidating earlier completion evidence); otherwise restore the file.",
    );
  }

  const handles = new Map<string, Handle>();
  const settledQueue: { h: Handle; report: string }[] = [];
  let nextId = store.maxWorkerId() + 1;
  let dispatchedThisWake = 0;
  let verifiedThisWake = 0;
  let declaration: { state: "pause" | "complete"; reason: string } | undefined;
  let lastWakeText = "";

  const coordinatorScope: WriteScope = {
    allow: [dir],
    deny: [
      path.join(dir, ".coverify"),
      path.join(dir, "STATEMENT.md"),
      path.join(dir, "PROVED.md"),
    ],
  };

  const evidenceRelative = (p: string): string | undefined => {
    const resolved = path.resolve(dir, "EVIDENCE", p);
    return resolved.startsWith(path.join(dir, "EVIDENCE") + path.sep)
      ? path.relative(path.join(dir, "EVIDENCE"), resolved)
      : undefined;
  };

  const liveOnMechanism = (mechanism: string): number =>
    [...handles.values()].filter((h) => h.mechanism === mechanism).length;

  const dispatchWorker: AgentTool = {
    name: "dispatch_worker",
    label: "Dispatch worker",
    description:
      "Dispatch a fresh minimal-context worker on one packet with one finite mathematical " +
      "deliverable. Returns a handle id immediately; the report arrives at a later wake. " +
      "The packet must include the FAILED.md check record.",
    parameters: Type.Object({
      mechanism: Type.String({ description: "Mechanism identifier for the registry" }),
      task: Type.String({ description: "Exact task" }),
      context: Type.String({ description: "Constraints, promoted premises, nearest failed boundary" }),
      deliverable: Type.String({ description: "The finite mathematical deliverable" }),
      failedCheck: Type.String({
        description:
          "'no close prior route' or 'closest prior route is X; this differs materially because ...'",
      }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const packet = params as WorkerPacket;
      const decision = checkWorkerDispatch(
        store,
        packet,
        opts.userAgentLimit,
        handles.size,
        liveOnMechanism(packet.mechanism),
      );
      if (!decision.allowed) return toolText(`DISPATCH REFUSED: ${decision.reason}`);
      const id = `w${String(nextId++).padStart(3, "0")}`;
      const evidenceDir = path.join(dir, "EVIDENCE", id);
      fs.mkdirSync(evidenceDir, { recursive: true });
      store.append({ kind: "dispatch", id, mechanism: packet.mechanism, task: packet.task });
      const promise = runRole({
        contract,
        charge: CHARGES.worker,
        prompt: `Assigned evidence directory: ${evidenceDir}\n\n# Task\n\n${packet.task}\n\n# Deliverable\n\n${packet.deliverable}\n\n# Context\n\n${packet.context}`,
        bash: { cwd: evidenceDir, scope: { allow: [evidenceDir], deny: [] } },
        modelId: opts.modelId,
        models,
      });
      const handle: Handle = { id, mechanism: packet.mechanism, promise };
      handles.set(id, handle);
      promise.then((report) => settledQueue.push({ h: handle, report }));
      dispatchedThisWake++;
      return toolText(
        `dispatched ${id} (${handles.size} live). The report will arrive at a later wake.` +
          (decision.warning ? `\n${decision.warning}` : ""),
      );
    },
  } as AgentTool;

  const dispatchGateCritic: AgentTool = {
    name: "dispatch_gate_critic",
    label: "Idea gate",
    description:
      "Run a fresh idea-gate critic on one mechanism before investing a wave in it. Give only " +
      "the frozen target, promoted premises, the mechanism, and its claimed first nontrivial implication.",
    parameters: Type.Object({
      mechanism: Type.String(),
      firstImplication: Type.String({ description: "The claimed first nontrivial implication" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { mechanism: string; firstImplication: string };
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = readLedger(dir, "PROVED.md");
      const text = await runRole({
        contract,
        charge: CHARGES.gateCritic,
        prompt: `# Frozen target\n\n${statement}\n\n# Promoted premises\n\n${proved}\n\n# Proposed mechanism\n\n${p.mechanism}\n\n# Claimed first nontrivial implication\n\n${p.firstImplication}`,
        modelId: opts.modelId,
        models,
      });
      const verdict = recordGateVerdict(store, p.mechanism, text);
      if (verdict === "UNPARSEABLE") {
        return toolText(
          `UNPARSEABLE verdict (recorded as such; does not unlock waves). The critic's first line ` +
          `was not a verdict token — re-run the gate.\n\n${text}`,
        );
      }
      return toolText(`${verdict}\n\n${text}`);
    },
  } as AgentTool;

  const requestVerification: AgentTool = {
    name: "request_verification",
    label: "Verification cadence",
    description:
      "Run the two-stage verification cadence on one exact candidate revision (an EVIDENCE-relative " +
      "filename). Stage 1: fresh hostile audit of the candidate. Stage 2: fresh no-context " +
      "reconstruction from statement + key ideas + allowed sources + promoted premises (never the " +
      "proof), then a fresh comparison mapping the reconstruction to the candidate's conclusions and " +
      "dependencies. Code records all verdicts bound to content hashes; promotion (record_promotion) " +
      "is only legal after both stages PASS on the exact revision.",
    parameters: Type.Object({
      revision: Type.String({ description: "EVIDENCE-relative candidate filename (revision identity)" }),
      declaredDependencies: Type.String({ description: "Declared dependencies of the candidate" }),
      keyIdeas: Type.String({
        description: "High-level key ideas for the reconstructor (not the proof or its paraphrase)",
      }),
      allowedSources: Type.String({
        description: "Allowed sources for the reconstructor (named theorems, background references)",
      }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as {
        revision: string;
        declaredDependencies: string;
        keyIdeas: string;
        allowedSources: string;
      };
      const rel = evidenceRelative(p.revision);
      if (!rel) return toolText(`revision must be a path inside EVIDENCE/ (got: ${p.revision})`);
      const candidatePath = path.join(dir, "EVIDENCE", rel);
      if (!fs.existsSync(candidatePath)) return toolText(`no such evidence revision: ${rel}`);
      const candidate = fs.readFileSync(candidatePath, "utf-8");
      const candidateHash = sha256File(candidatePath);
      const stmtHash = statementHash(dir);
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = readLedger(dir, "PROVED.md");
      const slug = rel.replace(/[\/]/g, "_");

      // Stage 1 — hostile audit (bundle includes PROVED.md so promoted claims are checkable).
      const auditText = await runRole({
        contract,
        charge: CHARGES.hostileAuditor,
        prompt: `# Statement\n\n${statement}\n\n# Currently promoted (PROVED.md)\n\n${proved}\n\n# Declared dependencies (coordinator-authored)\n\n${p.declaredDependencies}\n\n# Candidate revision ${rel}\n\n${candidate}`,
        modelId: opts.modelId,
        models,
      });
      const auditPass = parseFirstLineVerdict(auditText, ["VERDICT: PASS", "VERDICT: FAIL"]) === "VERDICT: PASS";
      const auditEvidence = newEvidencePath(dir, `audits/${slug}.audit`, nextEvidenceRev(dir, `audits/${slug}.audit`));
      fs.mkdirSync(path.dirname(auditEvidence), { recursive: true });
      fs.writeFileSync(auditEvidence, auditText);
      store.append({
        kind: "audit",
        revision: rel,
        verdict: auditPass ? "PASS" : "FAIL",
        candidateHash,
        statementHash: stmtHash,
        artifact: path.relative(dir, auditEvidence),
        suppliedInputs: ["candidate revision", "statement", "PROVED.md", "declared dependencies"],
        blindness:
          "fresh instance (enforced); bundle built by harness (enforced); declaredDependencies coordinator-authored (instructed only)",
        modelFamily: `anthropic/${opts.modelId}`,
      });
      verifiedThisWake++;
      if (!auditPass) {
        return toolText(`STAGE 1 FAIL — not verifier-backed. Audit saved: ${path.relative(dir, auditEvidence)}\n\n${auditText}`);
      }

      // Stage 2a — blind reconstruction (no verdict; the PASS belongs to the comparison).
      const reconText = await runRole({
        contract,
        charge: CHARGES.reconstructor,
        prompt: `# Statement\n\n${statement}\n\n# High-level key ideas\n\n${p.keyIdeas}\n\n# Allowed sources\n\n${p.allowedSources}\n\n# Promoted premises\n\n${proved}`,
        modelId: opts.modelId,
        models,
      });
      const reconEvidence = newEvidencePath(dir, `audits/${slug}.reconstruction`, nextEvidenceRev(dir, `audits/${slug}.reconstruction`));
      fs.writeFileSync(reconEvidence, reconText);
      store.append({
        kind: "reconstruction",
        revision: rel,
        candidateHash,
        statementHash: stmtHash,
        artifact: path.relative(dir, reconEvidence),
        suppliedInputs: ["statement", "key ideas", "allowed sources", "promoted premises"],
        blindness:
          "fresh instance (enforced); candidate file withheld by harness (enforced); keyIdeas coordinator-authored (instructed only — paraphrase risk not machine-checked)",
        modelFamily: `anthropic/${opts.modelId}`,
      });

      // Stage 2b — comparison: maps the reconstruction to the candidate's
      // conclusions and declared dependencies. This verdict is stage 2's PASS.
      const compareText = await runRole({
        contract,
        charge: CHARGES.comparator,
        prompt: `# Statement\n\n${statement}\n\n# Independent reconstruction\n\n${reconText}\n\n# Candidate revision ${rel}\n\n${candidate}\n\n# Declared dependencies\n\n${p.declaredDependencies}`,
        modelId: opts.modelId,
        models,
      });
      const comparePass = parseFirstLineVerdict(compareText, ["VERDICT: PASS", "VERDICT: FAIL"]) === "VERDICT: PASS";
      const compareEvidence = newEvidencePath(dir, `audits/${slug}.comparison`, nextEvidenceRev(dir, `audits/${slug}.comparison`));
      fs.writeFileSync(compareEvidence, compareText);
      store.append({
        kind: "comparison",
        revision: rel,
        verdict: comparePass ? "PASS" : "FAIL",
        candidateHash,
        statementHash: stmtHash,
        artifact: path.relative(dir, compareEvidence),
        suppliedInputs: ["statement", "reconstruction", "candidate", "declared dependencies"],
        blindness: "fresh instance (enforced); sees both sides by design (comparison step)",
        modelFamily: `anthropic/${opts.modelId}`,
      });
      const promotion = checkPromotion(store, dir, rel);
      return toolText(
        `STAGE 1 PASS; STAGE 2 ${comparePass ? "PASS" : "FAIL"} (comparison verdict). ` +
          (promotion.allowed
            ? `Revision ${rel} is verifier-backed; record_promotion is now legal for it.`
            : `Not promotable: ${promotion.reason}`) +
          `\nArtifacts: ${path.relative(dir, auditEvidence)}, ${path.relative(dir, reconEvidence)}, ${path.relative(dir, compareEvidence)}` +
          `\n\n## Stage 1 (hostile audit)\n\n${auditText}\n\n## Stage 2b (comparison)\n\n${compareText}`,
      );
    },
  } as AgentTool;

  const recordPromotion: AgentTool = {
    name: "record_promotion",
    label: "Record promotion",
    description:
      "The only way to append to PROVED.md. Legal only when both verification stages passed on the " +
      "exact revision and the candidate and STATEMENT.md are byte-identical to what was verified.",
    parameters: Type.Object({
      revision: Type.String({ description: "EVIDENCE-relative candidate filename" }),
      exactStatement: Type.String({ description: "The exact promoted statement" }),
      dependencies: Type.String({ description: "Dependency identities (promoted premises, imports)" }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { revision: string; exactStatement: string; dependencies: string };
      const rel = evidenceRelative(p.revision);
      if (!rel) return toolText(`revision must be a path inside EVIDENCE/ (got: ${p.revision})`);
      const decision = checkPromotion(store, dir, rel);
      if (!decision.allowed) return toolText(`PROMOTION REFUSED: ${decision.reason}`);
      const artifacts = store
        .all()
        .filter((e) => e.revision === rel && typeof e.artifact === "string")
        .map((e) => `${e.kind}: ${e.artifact}`)
        .join("; ");
      const entry =
        `\n## ${rel} — promoted ${new Date().toISOString()}\n\n` +
        `**Statement:** ${p.exactStatement}\n\n**Dependencies:** ${p.dependencies}\n\n` +
        `**Audit artifacts:** ${artifacts}\n`;
      fs.appendFileSync(path.join(dir, "PROVED.md"), entry);
      store.append({ kind: "promotion", revision: rel });
      return toolText(`Promotion recorded in PROVED.md for ${rel}. Update REGISTRY.md to label it 'promoted'.`);
    },
  } as AgentTool;

  const declareState: AgentTool = {
    name: "declare_campaign_state",
    label: "Declare campaign state",
    description:
      "Explicitly pause or complete the campaign. Completion requires at least one recorded " +
      "promotion (the contract's completion criterion demands the full cadence on the final result). " +
      "Pause is operational state, not blocked or complete.",
    parameters: Type.Object({
      state: Type.Union([Type.Literal("pause"), Type.Literal("complete")]),
      reason: Type.String(),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { state: "pause" | "complete"; reason: string };
      if (p.state === "complete" && !store.all().some((e) => e.kind === "promotion")) {
        return toolText(
          "DECLARATION REFUSED: no promotion is on record; the completion criterion requires the " +
            "final result to pass the full cadence (verify, then record_promotion) first.",
        );
      }
      declaration = p;
      return toolText(`Declared: ${p.state}. The harness will stop after this wake.`);
    },
  } as AgentTool;

  // Surface work lost to a previous crash: dispatched, never completed.
  const lost = store.dispatchesWithoutCompletion().filter((d) => !handles.has(d.id as string));
  let lostNote =
    lost.length > 0
      ? `Lost to a previous restart (dispatched, no report): ${lost
          .map((d) => `${d.id} [${d.mechanism}]`)
          .join(", ")}. Re-dispatch if still wanted.\n`
      : "";

  let wakeCount = 0;
  let noopWakes = 0;
  while (true) {
    wakeCount++;
    if (opts.maxWakes !== undefined && wakeCount > opts.maxWakes) {
      appendJournal(dir, { kind: "note", note: `user wake limit ${opts.maxWakes} reached; pausing` });
      return `${lastWakeText}\n\n[coverify: user wake limit reached; campaign paused, resume with 'coverify resume']`;
    }
    dispatchedThisWake = 0;
    verifiedThisWake = 0;
    const digest =
      handles.size === 0
        ? "No workers are currently running."
        : `Still running (do not interrupt for slowness): ${[...handles.values()]
            .map((h) => `${h.id} [${h.mechanism}]`)
            .join(", ")}`;
    const reports = settledQueue.splice(0, settledQueue.length);
    for (const s of reports) handles.delete(s.h.id);
    const reportSections = reports.map((s) => {
      const reportPath = newEvidencePath(dir, `${s.h.id}/report`, nextEvidenceRev(dir, `${s.h.id}/report`));
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, s.report);
      store.append({ kind: "completion", id: s.h.id, report: path.relative(dir, reportPath) });
      return `## ${s.h.id} [${s.h.mechanism}] (saved: ${path.relative(dir, reportPath)})\n\n${s.report}`;
    });
    appendJournal(dir, { kind: "wake", wake: wakeCount, live: handles.size, newReports: reports.length });
    const idleNudge =
      handles.size === 0 && reportSections.length === 0 && wakeCount > 1
        ? "\nNothing is live and no new reports arrived. Per the contract the campaign remains " +
          "authorized: dispatch the next materially new wave, or explicitly declare_campaign_state."
        : "";
    lastWakeText = await runRole({
      contract,
      charge: CHARGES.coordinator,
      prompt: `${resumeBundle(dir)}\n\n---\n\nCampaign directory: ${dir}\n${lostNote}${digest}${idleNudge}\n\n${
        reportSections.length > 0
          ? `# Newly completed work\n\n${reportSections.join("\n\n---\n\n")}`
          : "No new completions this wake."
      }`,
      bash: { cwd: dir, scope: coordinatorScope },
      extraTools: [dispatchWorker, dispatchGateCritic, requestVerification, recordPromotion, declareState],
      modelId: opts.modelId,
      models,
    });
    lostNote = "";

    // Frontier history: CURRENT_FRONTIER.md is rewritten by design, so the
    // harness snapshots each distinct post-wake version under .coverify/.
    // Pure audit metadata — nothing reads it; deleting it changes nothing.
    const frontier = readLedger(dir, "CURRENT_FRONTIER.md");
    const histDir = path.join(dir, ".coverify", "frontier-history");
    fs.mkdirSync(histDir, { recursive: true });
    const prev = fs.readdirSync(histDir).sort().at(-1);
    if (!prev || fs.readFileSync(path.join(histDir, prev), "utf-8") !== frontier) {
      fs.writeFileSync(path.join(histDir, `wake-${String(wakeCount).padStart(4, "0")}.md`), frontier);
    }

    if (declaration) {
      appendJournal(dir, { kind: "note", note: `declared ${declaration.state}: ${declaration.reason}` });
      return `${lastWakeText}\n\n[coverify: campaign ${declaration.state} — ${declaration.reason}]`;
    }
    if (handles.size === 0 && settledQueue.length === 0) {
      noopWakes = dispatchedThisWake === 0 && verifiedThisWake === 0 ? noopWakes + 1 : 0;
      if (noopWakes >= NOOP_WAKE_PAUSE) {
        appendJournal(dir, {
          kind: "note",
          note: `harness safety pause after ${NOOP_WAKE_PAUSE} no-op wakes; campaign remains authorized`,
        });
        return `${lastWakeText}\n\n[coverify: harness safety pause after ${NOOP_WAKE_PAUSE} idle wakes — the campaign remains authorized and incomplete; resume with 'coverify resume']`;
      }
      if (dispatchedThisWake === 0) continue;
    } else {
      noopWakes = 0;
    }
    if (handles.size > 0 && settledQueue.length === 0) {
      await Promise.race([...handles.values()].map((h) => h.promise));
    }
  }
}

/** Next free revision number for an evidence basename (append-only naming). */
function nextEvidenceRev(dir: string, base: string): number {
  for (let r = 1; ; r++) {
    const safe = base.replace(/[^A-Za-z0-9._\/-]/g, "-");
    if (!fs.existsSync(path.join(dir, "EVIDENCE", `${safe}.r${r}.md`))) return r;
  }
}
