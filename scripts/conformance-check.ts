#!/usr/bin/env bun
/**
 * Conformance check: the gates and role charges depend on exact tokens from
 * the launcher contract. If a skill edit renames any of them, this fails
 * loudly and names the drifted coupling. Deliberately dumb — a flat list of
 * literal substring checks, never a parser of the spec.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
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
/** Every .ts under a root, recursively — a `src/anything/` subdirectory added
 *  later must not become invisible to a check. */
const tsFiles = (root: string): string[] =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((p) => p.endsWith(".ts"))
        .map((p) => path.join(root, p))
    : [];

// src/telemetry/ is the deletable measurement extension: `rm -rf src/telemetry`
// must leave a working harness (design rule 2), which holds only while no core
// file imports it. cli.ts is the operator surface and is the one module allowed
// to read it. The property was verified by hand in commit messages until this
// check started enforcing it.
const violations: string[] = [];
for (const abs of tsFiles(path.join(repoRoot(), "src"))) {
  const rel = path.relative(repoRoot(), abs);
  if (rel === "src/cli.ts" || rel.startsWith("src/telemetry/")) continue;
  const text = fs.readFileSync(abs, "utf-8");
  if (/from "\.[./]*\/?telemetry\//.test(text)) violations.push(`${rel} -> src/telemetry/`);
}
if (violations.length > 0) {
  console.error("LAYER VIOLATION — core imported the deletable measurement extension:");
  for (const v of violations) console.error(`  ${v}`);
  console.error("telemetry/ is deletable: move the shared logic into core, or read it from cli.ts.");
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
  "src/telemetry/limits.ts", // ~/.codex/sessions — codex's own rollouts, absent = reported absent
]);
const hidden: string[] = [];
const allowlistHits = new Set<string>();
for (const abs of tsFiles(path.join(repoRoot(), "src"))) {
  const rel = path.relative(repoRoot(), abs);
  if (HOME_PATH_ALLOWED.has(rel)) {
    allowlistHits.add(rel);
    continue;
  }
  const text = fs.readFileSync(abs, "utf-8");
  // A homedir() join, or an absolute path into someone's checkout.
  if (/homedir\(\)\s*,/.test(text) || /"\/Users\/|"\/home\//.test(text)) hidden.push(rel);
}
// An allowlist entry that matches nothing is a check that quietly narrowed:
// `src/view/limits.ts` sat here after the file moved to `src/telemetry/`, and
// because the scan was a hardcoded two-directory list rather than a recursive
// walk, the whole telemetry folder went unchecked without anything turning red.
const stale = [...HOME_PATH_ALLOWED].filter((e) => !allowlistHits.has(e));
if (stale.length > 0) {
  console.error("STALE ALLOWLIST — HOME_PATH_ALLOWED names a file that does not exist:");
  for (const s of stale) console.error(`  ${s}`);
  console.error("Delete the entry, or fix the path it was meant to exempt.");
  process.exit(1);
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

// Delegated-call attribution. The librarian's leaf must read the session's
// LIVE parent, because a dispatched session is built before its dispatch span
// exists and receives it later through setTelemetryParent. Passing the
// build-time `opts.parent` compiles, runs, and silently produces leaves with no
// dispatchId and no wake — worse attribution than the unmetered record it
// replaced. No unit test catches it: the callback is internal to
// createHarnessRoleSession, so a test supplies its own and pins nothing.
const providersSrc = fs.readFileSync(path.join(repoRoot(), "src/providers.ts"), "utf-8");
// Call sites only — the declaration names its parameter `parent`.
const delegatedCalls = [...providersSrc.matchAll(/(?<!function )leafDelegatedCall\(\s*([A-Za-z.]+)/g)].map(
  (m) => m[1],
);
const badDelegated = delegatedCalls.filter((arg) => arg !== "spanParent");
if (delegatedCalls.length === 0 || badDelegated.length > 0) {
  console.error(
    `DELEGATED-CALL ATTRIBUTION — leafDelegatedCall must take \`spanParent\`, got \`${badDelegated[0] ?? "no call site"}\`.`,
  );
  console.error(
    "`opts.parent` is undefined for every dispatched session; the live parent arrives via\n" +
      "setTelemetryParent after the tools are built. See tests/librarian.test.ts for the edges this buys.",
  );
  process.exit(1);
}

// Knob registry vs reality (#45). The registry declares NAMES, not defaults —
// each default lives at its one read site — and it is only worth having if that
// name list is COMPLETE: the usage text and the run stamp both derive from it,
// so a knob read but not declared is silently absent from both, and a campaign
// cannot prove it was set. The old hand-written list named 5 of 31, which is
// exactly how that fails.
const declared = new Set(KNOBS.map((k) => k.name));
const seen = new Set<string>();
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
    // Skip this file: it MENTIONS the pattern in comments and in its own
    // regexes, and counting those made 3 of the 7 reported sites prose — a
    // blind-spot metric that was itself mostly noise.
    if (path.basename(p) === "knobs.ts" || p === fileURLToPath(import.meta.url)) continue;
    const text = fs.readFileSync(p, "utf-8");
    dynamicReads += [...text.matchAll(/process\.env\[\s*(?!")/g)].length;
  }
}

const undeclared = [...seen].filter((n) => !declared.has(n));
if (undeclared.length > 0) {
  console.error("UNDECLARED KNOB — read in src/ but missing from src/knobs.ts:");
  for (const n of undeclared) console.error(`  ${n}`);
  console.error(
    "Add it to KNOBS (the name, not its default — that stays at the read site). Undeclared\n" +
      "means absent from the generated usage text and from the run stamp, so a campaign\n" +
      "cannot prove it was set.",
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
  `conformance ok: ${REQUIRED.length} launcher tokens present; telemetry/ stays deletable; ` +
    `no hidden home-path dependency; ${KNOBS.length} knobs declared, none undeclared ` +
    `(${dynamicReads} computed-key read site(s) cannot be checked statically)`,
);
