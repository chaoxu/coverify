#!/usr/bin/env bun
/**
 * Conformance check: the gates and role charges depend on exact tokens from
 * the launcher contract. If a skill edit renames any of them, this fails
 * loudly and names the drifted coupling. Deliberately dumb — a flat list of
 * literal substring checks, never a parser of the spec.
 */
import * as fs from "node:fs";
import { KNOBS } from "../src/knobs.js";
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

// Knob registry vs reality (#45). The registry is only worth having if it is
// COMPLETE: its value is that the usage text, the run stamp and `coverify
// config` all derive from one table, and a knob missing from the table is
// silently missing from all three. The old hand-written list named 5 of 31,
// which is exactly how that fails.
const declared = new Set(KNOBS.map((k) => k.name));
const seen = new Set<string>();
/** Every .ts under a root, recursively — a `src/anything/` subdirectory added
 *  later must not become invisible to this check. */
const tsFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
};
for (const root of ["src", "scripts", "bin"]) {
  for (const p of tsFiles(path.join(repoRoot(), root))) {
    if (path.basename(p) === "knobs.ts") continue;
    const text = fs.readFileSync(p, "utf-8");
    // Every read FORM, not just the dot one. The first version matched only
    // `process.env.NAME`, and the codebase's own idiomatic reads are bracket
    // forms — providers.ts reads `process.env[`COVERIFY_EFFORT_${...}`]` and
    // `process.env[env]` — so the check was vacuously green over the very
    // sites it exists to police. Digits are allowed in names too.
    for (const m of text.matchAll(
      /process\.env\.(COVERIFY_[A-Z0-9_]+)|process\.env\[\s*"(COVERIFY_[A-Z0-9_]+)"|env:\s*"(COVERIFY_[A-Z0-9_]+)"|\{\s*(COVERIFY_[A-Z0-9_]+)[^}]*\}\s*=\s*process\.env/g,
    )) {
      seen.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
    }
  }
}
// Honest limit: a read through a computed key — `process.env[someVariable]` —
// cannot be resolved by static matching. providers.ts uses that form legitimately
// (envSpec(env), and the COVERIFY_EFFORT_${ROLE} template), and those knobs are
// declared, but a NEW dynamic read could introduce an undeclared one invisibly.
// Counting the sites keeps the blind spot in view instead of implying coverage
// the check does not have.
let dynamicReads = 0;
for (const root of ["src", "scripts", "bin"]) {
  for (const p of tsFiles(path.join(repoRoot(), root))) {
    if (path.basename(p) === "knobs.ts") continue;
    const text = fs.readFileSync(p, "utf-8");
    dynamicReads += [...text.matchAll(/process\.env\[\s*(?!")/g)].length;
  }
}

const undeclared = [...seen].filter((n) => !declared.has(n));
if (undeclared.length > 0) {
  console.error("UNDECLARED KNOB — read in src/ but missing from src/knobs.ts:");
  for (const n of undeclared) console.error(`  ${n}`);
  console.error(
    "Add it to KNOBS. Undeclared means absent from `coverify config`, from the generated\n" +
      "usage text, and from the run stamp — so a campaign cannot prove it was set.",
  );
  process.exit(1);
}
// The computed families (COVERIFY_MODEL_<ROLE>, COVERIFY_EFFORT_<ROLE>) are
// built from a suffix list here and from ROLE_ENV in providers.ts. Pin that
// they agree, or the registry quietly describes a role that does not exist.
const roleEnvNames = [
  ...fs
    .readFileSync(path.join(repoRoot(), "src", "providers.ts"), "utf-8")
    .matchAll(/"(COVERIFY_MODEL_[A-Z]+)"/g),
].map((m) => m[1]);
const missingRoles = roleEnvNames.filter((n) => !declared.has(n));
if (missingRoles.length > 0) {
  console.error(`KNOB REGISTRY DRIFT — providers.ts routes roles the registry does not declare:`);
  for (const n of missingRoles) console.error(`  ${n}`);
  process.exit(1);
}

console.log(
  `conformance ok: ${REQUIRED.length} launcher tokens present; view/ layer boundary intact; ` +
    `no hidden home-path dependency; ${KNOBS.length} knobs declared, none undeclared ` +
    `(${dynamicReads} computed-key read site(s) cannot be checked statically)`,
);
