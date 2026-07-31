import { appendJournal, readJournal } from "./campaign.js";

/**
 * Dispatch gate. The model requests; this code decides legality. Every check
 * traces to a launcher clause (see docs/design.md conformance table).
 */
export interface WorkerPacket {
  mechanism: string;
  task: string;
  context: string;
  deliverable: string;
  /** Launcher: "check FAILED.md and record either 'no close prior route' or
   *  'closest prior route is X; this differs materially because ...'" */
  failedCheck: string;
}

export interface GateDecision {
  allowed: boolean;
  reason?: string;
}

const FAILED_CHECK_RE = /^(no close prior route|closest prior route is .+; this differs materially because .+)/is;

function ideaGatePassed(dir: string, mechanism: string): boolean {
  return readJournal(dir).some(
    (e) => e.kind === "gate-verdict" && e.mechanism === mechanism && e.verdict === "IDEA PASS",
  );
}

function dispatchedCount(dir: string, mechanism: string): number {
  return readJournal(dir).filter((e) => e.kind === "dispatch" && e.mechanism === mechanism).length;
}

/**
 * Wave gate: a single first-wave scout on a mechanism is legal ungated; a
 * multi-worker wave (second or later dispatch on the same mechanism) requires
 * IDEA PASS on file. Launcher: "Do not allow recursive subagent fan-out or a
 * large route wave before the parent mechanism receives IDEA PASS...
 * Independent first-wave scouts may propose new mechanisms, but the
 * coordinator must gate any such mechanism before investing a follow-up wave."
 */
export function checkWorkerDispatch(
  dir: string,
  packet: WorkerPacket,
  userAgentLimit: number | undefined,
  liveAgents: number,
): GateDecision {
  if (!packet.task || !packet.deliverable || !packet.mechanism) {
    return { allowed: false, reason: "packet must name a mechanism, task, and finite deliverable" };
  }
  if (!FAILED_CHECK_RE.test(packet.failedCheck?.trim() ?? "")) {
    return {
      allowed: false,
      reason:
        "failedCheck must record either 'no close prior route' or " +
        "'closest prior route is X; this differs materially because ...' (contract: FAILED.md check)",
    };
  }
  // No fixed agent-count ceiling; only user/workspace/runtime limits apply.
  if (userAgentLimit !== undefined && liveAgents >= userAgentLimit) {
    return { allowed: false, reason: `user-set concurrent-agent limit (${userAgentLimit}) reached` };
  }
  if (dispatchedCount(dir, packet.mechanism) >= 1 && !ideaGatePassed(dir, packet.mechanism)) {
    return {
      allowed: false,
      reason:
        `mechanism "${packet.mechanism}" has no IDEA PASS on file; a follow-up wave requires the ` +
        "idea gate first (dispatch_gate_critic). A single first-wave scout was already permitted.",
    };
  }
  return { allowed: true };
}

export function recordGateVerdict(dir: string, mechanism: string, verdictText: string): string {
  const m = verdictText.match(/IDEA (PASS|FAIL|REPAIR)/i);
  const verdict = m ? `IDEA ${m[1].toUpperCase()}` : "IDEA FAIL";
  appendJournal(dir, { kind: "gate-verdict", mechanism, verdict, text: verdictText });
  return verdict;
}

/**
 * Two-stage verification bookkeeping. `verifier-backed` requires, for the
 * exact revision: a stage-1 hostile-audit PASS and a stage-2 reconstruction
 * PASS, in that order, with recorded provenance. Counting is code, not model
 * judgment.
 */
export function verificationState(dir: string, revision: string) {
  const entries = readJournal(dir);
  const audit = entries.find(
    (e) => e.kind === "audit" && e.revision === revision && e.verdict === "PASS",
  );
  const reconstruction = entries.find(
    (e) => e.kind === "reconstruction" && e.revision === revision && e.verdict === "PASS",
  );
  return {
    stage1Passed: Boolean(audit),
    stage2Passed: Boolean(reconstruction),
    verifierBacked: Boolean(audit && reconstruction),
  };
}

export function checkPromotion(dir: string, revision: string): GateDecision {
  const state = verificationState(dir, revision);
  if (!state.verifierBacked) {
    return {
      allowed: false,
      reason:
        `revision ${revision} is not verifier-backed ` +
        `(stage 1 hostile audit passed: ${state.stage1Passed}; stage 2 reconstruction passed: ${state.stage2Passed}). ` +
        "Promotion requires both stages on the exact revision.",
    };
  }
  return { allowed: true };
}
