import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  appendJournal,
  newEvidencePath,
  readLedger,
  resumeBundle,
} from "./campaign.js";
import { checkPromotion, checkWorkerDispatch, recordGateVerdict, type WorkerPacket } from "./gates.js";
import { loadLauncherContract } from "./launcher.js";
import { buildModels, CHARGES, runRole } from "./roles.js";

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

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * The harness event loop — the only persistent process. Completions wake an
 * ephemeral coordinator with a rebuilt minimal bundle; there is no resident
 * model conversation and no polling.
 */
export async function runCampaign(opts: CampaignOptions): Promise<string> {
  const dir = opts.campaignDir;
  const contract = loadLauncherContract();
  const models = buildModels();
  const handles = new Map<string, Handle>();
  let nextId = 1;
  let dispatchedThisWake = 0;
  let lastWakeText = "";

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
      const decision = checkWorkerDispatch(dir, packet, opts.userAgentLimit, handles.size);
      if (!decision.allowed) return toolText(`DISPATCH REFUSED: ${decision.reason}`);
      const id = `w${String(nextId++).padStart(3, "0")}`;
      const evidenceDir = path.join(dir, "EVIDENCE", id);
      fs.mkdirSync(evidenceDir, { recursive: true });
      appendJournal(dir, { kind: "dispatch", id, mechanism: packet.mechanism, task: packet.task });
      const promise = runRole({
        contract,
        charge: CHARGES.worker,
        prompt: `Assigned evidence directory: ${evidenceDir}\n\n# Task\n\n${packet.task}\n\n# Deliverable\n\n${packet.deliverable}\n\n# Context\n\n${packet.context}`,
        cwd: evidenceDir,
        modelId: opts.modelId,
        models,
      });
      handles.set(id, { id, mechanism: packet.mechanism, promise });
      dispatchedThisWake++;
      return toolText(`dispatched ${id} (${handles.size} live). The report will arrive at a later wake.`);
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
      const verdict = recordGateVerdict(dir, p.mechanism, text);
      return toolText(`${verdict}\n\n${text}`);
    },
  } as AgentTool;

  const requestVerification: AgentTool = {
    name: "request_verification",
    label: "Verification cadence",
    description:
      "Run the two-stage verification cadence on one exact candidate revision (an EVIDENCE " +
      "filename). Stage 1: fresh hostile audit of the candidate. Stage 2: fresh no-context " +
      "reconstruction from statement + key ideas + promoted premises only. Code records both " +
      "verdicts; promotion is only legal when both PASS for this exact revision.",
    parameters: Type.Object({
      revision: Type.String({ description: "EVIDENCE-relative candidate filename (revision identity)" }),
      declaredDependencies: Type.String({ description: "Declared dependencies of the candidate" }),
      keyIdeas: Type.String({
        description: "High-level key ideas for the reconstructor (not the proof or its paraphrase)",
      }),
    }),
    executionMode: "sequential",
    execute: async (_id: string, params: unknown) => {
      const p = params as { revision: string; declaredDependencies: string; keyIdeas: string };
      const candidatePath = path.join(dir, "EVIDENCE", p.revision);
      if (!fs.existsSync(candidatePath)) {
        return toolText(`no such evidence revision: ${p.revision}`);
      }
      const candidate = fs.readFileSync(candidatePath, "utf-8");
      const statement = readLedger(dir, "STATEMENT.md");
      const proved = readLedger(dir, "PROVED.md");

      // Stage 1 — hostile audit. Bundle: exact revision + statement + declared deps.
      const auditText = await runRole({
        contract,
        charge: CHARGES.hostileAuditor,
        prompt: `# Statement\n\n${statement}\n\n# Declared dependencies\n\n${p.declaredDependencies}\n\n# Candidate revision ${p.revision}\n\n${candidate}`,
        modelId: opts.modelId,
        models,
      });
      const auditPass = /^\s*VERDICT:\s*PASS/m.test(auditText);
      appendJournal(dir, {
        kind: "audit",
        revision: p.revision,
        verdict: auditPass ? "PASS" : "FAIL",
        suppliedInputs: ["candidate revision", "statement", "declared dependencies"],
        blindness: "fresh instance; bundle constructed by harness (platform-enforced)",
        modelFamily: `anthropic/${opts.modelId}`,
      });
      if (!auditPass) return toolText(`STAGE 1 FAIL — not verifier-backed.\n\n${auditText}`);

      // Stage 2 — blind reconstruction. Bundle deliberately excludes the proof.
      const reconText = await runRole({
        contract,
        charge: CHARGES.reconstructor,
        prompt: `# Statement\n\n${statement}\n\n# High-level key ideas\n\n${p.keyIdeas}\n\n# Promoted premises\n\n${proved}`,
        modelId: opts.modelId,
        models,
      });
      const reconPass = /^\s*VERDICT:\s*PASS/m.test(reconText);
      appendJournal(dir, {
        kind: "reconstruction",
        revision: p.revision,
        verdict: reconPass ? "PASS" : "FAIL",
        suppliedInputs: ["statement", "key ideas", "promoted premises"],
        blindness: "fresh instance; candidate proof withheld by harness (platform-enforced)",
        modelFamily: `anthropic/${opts.modelId}`,
      });
      const promotion = checkPromotion(dir, p.revision);
      return toolText(
        `STAGE 1 PASS; STAGE 2 ${reconPass ? "PASS" : "FAIL"}. ` +
          (promotion.allowed
            ? `Revision ${p.revision} is verifier-backed; you may record the promotion in PROVED.md ` +
              "with dependencies and audit provenance per the contract."
            : `Not promotable: ${promotion.reason}`) +
          `\n\n## Stage 1 (hostile audit)\n\n${auditText}\n\n## Stage 2 (reconstruction)\n\n${reconText}`,
      );
    },
  } as AgentTool;

  // The event loop: wake -> maybe dispatch -> await next completion -> wake.
  let wakeCount = 0;
  let pendingReports: string[] = [];
  while (true) {
    wakeCount++;
    if (opts.maxWakes !== undefined && wakeCount > opts.maxWakes) {
      appendJournal(dir, { kind: "note", note: `user wake limit ${opts.maxWakes} reached; pausing` });
      return `${lastWakeText}\n\n[coverify: user wake limit reached; campaign paused, resume with 'coverify resume']`;
    }
    dispatchedThisWake = 0;
    const digest =
      handles.size === 0
        ? "No workers are currently running."
        : `Still running (do not interrupt for slowness): ${[...handles.values()]
            .map((h) => `${h.id} [${h.mechanism}]`)
            .join(", ")}`;
    appendJournal(dir, { kind: "wake", wake: wakeCount, live: handles.size });
    lastWakeText = await runRole({
      contract,
      charge: CHARGES.coordinator,
      prompt: `${resumeBundle(dir)}\n\n---\n\nCampaign directory: ${dir}\n${digest}\n\n${
        pendingReports.length > 0
          ? `# Newly completed work\n\n${pendingReports.join("\n\n---\n\n")}`
          : "No new completions this wake (campaign start or review wake)."
      }`,
      cwd: dir,
      extraTools: [dispatchWorker, dispatchGateCritic, requestVerification],
      modelId: opts.modelId,
      models,
    });
    pendingReports = [];

    if (handles.size === 0) {
      if (dispatchedThisWake === 0) return lastWakeText; // coordinator chose to stop with nothing live
      continue;
    }
    // Await the next completion — whichever lands first wakes the next turn.
    const settled = await Promise.race(
      [...handles.values()].map((h) => h.promise.then((report) => ({ h, report }))),
    );
    handles.delete(settled.h.id);
    const reportPath = newEvidencePath(dir, `${settled.h.id}-report`, 1);
    fs.writeFileSync(reportPath, settled.report);
    appendJournal(dir, { kind: "completion", id: settled.h.id, report: path.basename(reportPath) });
    pendingReports.push(`## ${settled.h.id} [${settled.h.mechanism}] (saved: EVIDENCE/${path.basename(reportPath)})\n\n${settled.report}`);
  }
}
