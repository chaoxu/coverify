#!/usr/bin/env bun
/**
 * Conformance check: the gates and role charges depend on exact tokens from
 * the launcher contract. If a skill edit renames any of them, this fails
 * loudly and names the drifted coupling. Deliberately dumb — a flat list of
 * literal substring checks, never a parser of the spec.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot } from "../src/campaign.js";
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
  { token: "candidate", usedBy: "campaign.ts initCampaign REGISTRY.md template (claim-label vocabulary)" },
  { token: "self-audited", usedBy: "campaign.ts initCampaign REGISTRY.md template (claim-label vocabulary)" },
  { token: "verifier-backed", usedBy: "campaign.ts initCampaign REGISTRY.md template (claim-label vocabulary)" },
  { token: "promoted", usedBy: "campaign.ts initCampaign REGISTRY.md template (claim-label vocabulary)" },
  { token: "independently audited", usedBy: "campaign.ts initCampaign REGISTRY.md template (claim-label vocabulary)" },
  { token: "hostile auditor", usedBy: "roles.ts CHARGES.hostileAuditor (stage 1)" },
  { token: "fresh comparison agent", usedBy: "roles.ts CHARGES.comparator" },
  { token: "stepwise paraphrase", usedBy: "roles.ts CHARGES.bundleCertifier" },
  { token: "Do not rerun a failed stage", usedBy: "cadence.ts anti-verdict-shopping gate" },
];

const contract = loadLauncherContract();
const missing = REQUIRED.filter((r) => !contract.includes(r.token));
if (missing.length > 0) {
  console.error("CONFORMANCE DRIFT — launcher no longer contains tokens the harness depends on:");
  for (const m of missing) console.error(`  "${m.token}"  (used by ${m.usedBy})`);
  console.error("Update the coupled enforcement (see docs/design.md conformance table) or the launcher.");
  process.exit(1);
}
// Layer boundary (Chao, 2026-08-09): src/view/ is READ-ONLY CONSUMERS —
// trace rendering and session telemetry. Nothing that runs a campaign may
// depend on them, so observation can never change what a campaign concludes
// and can be reasoned about (and counted) separately. cli.ts is the operator
// surface and is the one module allowed to render a view.
// A view may read core; core may not read a view — only the reverse edge
// needs guarding.
const violations: string[] = [];
for (const f of fs.readdirSync(path.join(repoRoot(), "src"))) {
  if (!f.endsWith(".ts") || f === "cli.ts") continue;
  const text = fs.readFileSync(path.join(repoRoot(), "src", f), "utf-8");
  if (/from "\.\/view\//.test(text)) violations.push(`src/${f}`);
}
if (violations.length > 0) {
  console.error("LAYER VIOLATION — operational code imported a read-only view:");
  for (const v of violations) console.error(`  ${v} imports src/view/*`);
  console.error("Views are pure consumers: move the shared logic into core, or read it from cli.ts.");
  process.exit(1);
}
// Self-containment: coverify must run from a clean clone with no external
// file. It used to read its own SPEC from ~/kb — a personal knowledge base
// nobody else has — so no campaign ran and this very check failed on a fresh
// checkout (#44). The contract now ships in the repo, and this stops that
// regressing silently: a src/ file that reaches into a hand-written home path
// is a hidden dependency, and the failure mode is invisible to anyone who
// happens to have the file.
//
// The legitimate home paths are user-scoped state, not repo inputs: XDG-style
// state and config, the vendors' own CLI data directories, and read-scope
// denials. They are listed rather than pattern-matched, so adding one is a
// deliberate edit here.
const HOME_PATH_ALLOWED = new Set([
  "src/credentials.ts", // ~/.config/coverify/auth.json — the user's credentials
  "src/gates.ts", // ~/.local/state/coverify — XDG state (COVERIFY_STATE_DIR)
  "src/workspace.ts", // ~/.gemini, ~/.antigravity — read-scope DENIALS, plus ~ expansion
  "src/view/limits.ts", // ~/.codex/sessions — codex's own rollouts, absent = reported absent
]);
const hidden: string[] = [];
for (const dir of ["src", "src/view"]) {
  for (const f of fs.readdirSync(path.join(repoRoot(), dir))) {
    if (!f.endsWith(".ts")) continue;
    const rel = `${dir}/${f}`;
    if (HOME_PATH_ALLOWED.has(rel)) continue;
    const text = fs.readFileSync(path.join(repoRoot(), rel), "utf-8");
    // A homedir() join, or an absolute path into someone's checkout.
    if (/homedir\(\)\s*,/.test(text) || /"\/Users\/|"\/home\//.test(text)) hidden.push(rel);
  }
}
if (hidden.length > 0) {
  console.error("HIDDEN DEPENDENCY — a clean clone would not have this:");
  for (const h of hidden) console.error(`  ${h} resolves a path under the user's home directory`);
  console.error(
    "Ship it in the repo (see contract/), or add it to HOME_PATH_ALLOWED with a note\n" +
      "saying why it is user-scoped state rather than an input the repo owes the reader.",
  );
  process.exit(1);
}

console.log(
  `conformance ok: ${REQUIRED.length} launcher tokens present; view/ layer boundary intact; ` +
    "no hidden home-path dependency",
);
