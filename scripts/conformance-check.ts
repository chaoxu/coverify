#!/usr/bin/env bun
/**
 * Conformance check: the gates and role charges depend on exact tokens from
 * the launcher contract. If a skill edit renames any of them, this fails
 * loudly and names the drifted coupling. Deliberately dumb — a flat list of
 * literal substring checks, never a parser of the spec.
 */
import { loadLauncherContract } from "../src/launcher.js";

const REQUIRED: { token: string; usedBy: string }[] = [
  { token: "IDEA PASS", usedBy: "gates.ts recordGateVerdict / wave gate" },
  { token: "IDEA FAIL", usedBy: "gates.ts recordGateVerdict" },
  { token: "IDEA REPAIR", usedBy: "gates.ts recordGateVerdict" },
  { token: "no close prior route", usedBy: "gates.ts FAILED_CHECK_RE" },
  { token: "closest prior route is", usedBy: "gates.ts FAILED_CHECK_RE" },
  { token: "this differs materially because", usedBy: "gates.ts FAILED_CHECK_RE" },
  { token: "STATEMENT.md", usedBy: "campaign.ts ledger set / statement freeze" },
  { token: "CURRENT_FRONTIER.md", usedBy: "campaign.ts ledger set / resume bundle" },
  { token: "REGISTRY.md", usedBy: "campaign.ts ledger set" },
  { token: "FAILED.md", usedBy: "campaign.ts ledger set / dispatch schema" },
  { token: "PROVED.md", usedBy: "campaign.ts ledger set / record_promotion" },
  { token: "PROCESS_LESSONS.md", usedBy: "campaign.ts ledger set" },
  { token: "candidate", usedBy: "campaign.ts CLAIM_LABELS" },
  { token: "self-audited", usedBy: "campaign.ts CLAIM_LABELS" },
  { token: "verifier-backed", usedBy: "campaign.ts CLAIM_LABELS" },
  { token: "promoted", usedBy: "campaign.ts CLAIM_LABELS" },
  { token: "independently audited", usedBy: "campaign.ts CLAIM_LABELS" },
  { token: "hostile auditor", usedBy: "roles.ts CHARGES.hostileAuditor (stage 1)" },
  { token: "fresh comparison agent", usedBy: "harness.ts stage 2 comparator" },
  { token: "stepwise paraphrase", usedBy: "harness.ts bundle certification" },
  { token: "Do not rerun a failed stage", usedBy: "harness.ts anti-verdict-shopping gate" },
];

const contract = loadLauncherContract();
const missing = REQUIRED.filter((r) => !contract.includes(r.token));
if (missing.length > 0) {
  console.error("CONFORMANCE DRIFT — launcher no longer contains tokens the harness depends on:");
  for (const m of missing) console.error(`  "${m.token}"  (used by ${m.usedBy})`);
  console.error("Update the coupled enforcement (see docs/design.md conformance table) or the launcher.");
  process.exit(1);
}
console.log(`conformance ok: ${REQUIRED.length} launcher tokens present`);
