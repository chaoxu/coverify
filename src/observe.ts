/**
 * Observability, separated from operations (Chao, 2026-08-08): everything
 * here RECORDS what happened or NOTICES what the records imply — nothing
 * here decides, schedules, gates, or executes. House rule from the same
 * day's review (issue #21): every record ships with the derived query that
 * makes it actionable — an unread log is not an audit trail. Removing this
 * module changes what the campaign can prove about itself, never what it
 * does (design rule 2).
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { danglingCitations, readLedger, sha256Text } from "./campaign.js";
import {
  GateStore,
  normalizeMechanism,
  promotionsMissingFromProved,
  retractionClosure,
} from "./gates.js";
import {
  ROLE_NAMES,
  cliBackendCommand,
  retryPolicy,
  roleModelSpec,
  sandboxMode,
  specLabel,
} from "./roles.js";

/**
 * Run-config stamp (issue #21 P2): the resolved, non-secret policy that
 * governed this run, recorded once at run start so results are attributable
 * to configurations without commit-vs-restart archaeology. Extends the
 * bare harnessRev/launcherSha stamp with everything the review found the
 * proposal missing: runtime + dependency identity (Bun, pi packages, the
 * patch file), a dirty-tree flag (rev-parse alone misattributes local
 * edits), and the sandbox enforcement mode (a threat-model fact that was
 * previously console.error-only).
 */
export function recordRunConfig(
  store: GateStore,
  extra: { harnessRev: string; launcherSha256: string; userAgentLimit?: number; maxWakes?: number },
): void {
  const repo = path.dirname(new URL(import.meta.url).pathname);
  const git = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: repo }).toString().trim();
    } catch {
      return undefined;
    }
  };
  const piVersion = (pkg: string): string | undefined => {
    try {
      const p = path.join(repo, "..", "node_modules", "@earendil-works", pkg, "package.json");
      return (JSON.parse(fs.readFileSync(p, "utf-8")) as { version?: string }).version;
    } catch {
      return undefined;
    }
  };
  const patchDir = path.join(repo, "..", "patches");
  let patches: Record<string, string> | undefined;
  try {
    patches = Object.fromEntries(
      fs.readdirSync(patchDir).map((f) => [f, sha256Text(fs.readFileSync(path.join(patchDir, f), "utf-8"))]),
    );
  } catch {
    /* no patches dir */
  }
  store.event({
    kind: "note",
    note: "run-start",
    // Structural marker: trace epoch-caps open dispatches on this, so it must
    // not depend on the prose note's exact wording.
    runStart: true,
    ...extra,
    gitDirty: git("git status --porcelain") !== "",
    bunVersion: process.versions.bun,
    piVersions: { "pi-agent-core": piVersion("pi-agent-core"), "pi-ai": piVersion("pi-ai") },
    ...(patches && Object.keys(patches).length > 0 ? { patches } : {}),
    roleSpecs: Object.fromEntries(
      ROLE_NAMES.map((r) => {
        const s = roleModelSpec(r);
        return [r, `${specLabel(s)}@${s.thinking}`];
      }),
    ),
    cliTemplates: {
      "claude-cli": cliBackendCommand("claude-cli"),
      "codex-cli": cliBackendCommand("codex-cli"),
    },
    retry: retryPolicy(),
    transport: process.env.COVERIFY_CODEX_TRANSPORT ?? "auto",
    coordinatorContextTokens: Number(process.env.COVERIFY_COORDINATOR_CONTEXT_TOKENS ?? 300_000),
    sandbox: sandboxMode(),
  });
}

/**
 * Rewritten-ledger history: CURRENT_FRONTIER.md and REGISTRY.md are
 * rewritten by design, so each distinct post-wake version is stored once,
 * content-addressed, with a hash-bound event carrying order and integrity
 * (an edited snapshot stops matching its recorded hash; A→B→A logs three
 * events, stores two snapshots). Reader on record: the vanished-intentions
 * audit (2026-08-08).
 */
export function archiveLedgerHistory(store: GateStore, dir: string, wakeCount: number): void {
  const histDir = path.join(dir, ".coverify", "ledger-history");
  fs.mkdirSync(histDir, { recursive: true });
  for (const ledger of ["CURRENT_FRONTIER.md", "REGISTRY.md"]) {
    // Tolerate absence: a foreign or freshly-adopted campaign may lack a
    // ledger; observability must never brick a run.
    if (!fs.existsSync(path.join(dir, ledger))) continue;
    const content = readLedger(dir, ledger);
    if (!content) continue;
    const hash = sha256Text(content);
    const last = [...store.all()].reverse().find((e) => e.ledgerRevision === ledger);
    if (last?.hash === hash) continue;
    const snap = path.join(histDir, `${hash}.md`);
    if (!fs.existsSync(snap)) fs.writeFileSync(snap, content);
    store.event({ kind: "note", ledgerRevision: ledger, hash, wake: wakeCount });
  }
}

/**
 * Refusal events (issue #21 P1): every dispatch- or verification-side
 * refusal is recorded at its choke point, generically — the reason is the
 * refusal text itself, so new refusal branches are covered without
 * enumeration. Matters most once --agent-limit binds: whether the
 * coordinator re-proposes or forgets refused work becomes auditable.
 */
export function recordRefusal(
  store: GateStore,
  site: "dispatch" | "verification",
  fields: { reason: string; mechanism?: string; revision?: string; role?: string },
): void {
  store.event({
    kind: "note",
    refusal: site,
    ...fields,
    reason: fields.reason.slice(0, 300),
  });
}

/**
 * The companion query: refusals whose subject never got a follow-up — a
 * dispatch refusal on a mechanism with no later dispatch on it, or a
 * verification refusal on a revision with no later verification dispatch.
 * Mechanical noticing only; whether a drop was right stays judgment.
 */
export function refusalsWithoutFollowup(
  store: GateStore,
): { site: string; subject: string; reason: string }[] {
  const records = store.all();
  const out: { site: string; subject: string; reason: string }[] = [];
  records.forEach((r, i) => {
    if (r.refusal === undefined) return;
    const later = records.slice(i + 1);
    if (r.refusal === "dispatch" && typeof r.mechanism === "string") {
      const key = normalizeMechanism(r.mechanism);
      const followed = later.some(
        (e) => e.kind === "dispatch" && typeof e.mechanism === "string" && normalizeMechanism(e.mechanism) === key,
      );
      if (!followed) out.push({ site: "dispatch", subject: r.mechanism, reason: String(r.reason ?? "") });
    } else if (r.refusal === "verification" && typeof r.revision === "string") {
      const rev = r.revision.toLowerCase();
      const followed = later.some(
        (e) =>
          e.kind === "dispatch" &&
          typeof e.mechanism === "string" &&
          e.mechanism.startsWith("verification:") &&
          e.mechanism.slice("verification:".length).toLowerCase() === rev,
      );
      if (!followed) out.push({ site: "verification", subject: r.revision, reason: String(r.reason ?? "") });
    }
  });
  // Dedup by subject: only the newest unaddressed refusal per subject matters.
  const seen = new Set<string>();
  return out.reverse().filter((r) => {
    const k = `${r.site}:${r.subject.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The wake's bookkeeping digest: mechanical noticing the coordinator would
 * otherwise have to remember — dangling citations, promotions contradicted
 * or edited out from under their events, and refused work nothing followed
 * up. Rendered as prompt text; deciding what to do about any of it is the
 * coordinator's judgment (contract).
 */
export function wakeBookkeeping(store: GateStore, dir: string): string {
  const dangling = danglingCitations(dir);
  const retractions = retractionClosure(store);
  const missingEntries = promotionsMissingFromProved(store, dir);
  const unaddressed = refusalsWithoutFollowup(store);
  return (
    (dangling.length > 0
      ? `\n\nLEDGER CITATIONS THAT POINT AT NOTHING (fix or remove them):\n` +
        dangling.map((d) => `- ${d.ledger} cites ${d.citation}, which does not exist`).join("\n")
      : "") +
    (missingEntries.length > 0
      ? `\n\nPROMOTION ENTRIES NO LONGER IN PROVED.md — the recorded entry text for these ` +
        `promotions does not appear in the file. If this is a recorded retraction relabel, note ` +
        `that in REGISTRY.md; otherwise the ledger was edited out from under its events — restore it:\n` +
        missingEntries.map((m) => `- ${m.revision}`).join("\n")
      : "") +
    (retractions.length > 0
      ? `\n\nPROMOTED CLAIMS WITH A LATER SUBSTANTIVE FAIL — the contract requires a retraction ` +
        `(relabel in REGISTRY.md, append to FAILED.md, mark the PROVED.md entry historical, ` +
        `demote dependents):\n` +
        retractions
          .map(
            (r) =>
              `- ${r.revision} (later ${r.stage} FAIL)` +
              (r.dependents.length > 0
                ? `; recorded dependents standing on it (transitive, via premises): ${r.dependents.join(", ")}`
                : ""),
          )
          .join("\n")
      : "") +
    (unaddressed.length > 0
      ? `\n\nREFUSED WORK NOTHING FOLLOWED UP (re-propose deliberately or drop deliberately):\n` +
        unaddressed.map((r) => `- [${r.site}] ${r.subject}: ${r.reason.slice(0, 120)}`).join("\n")
      : "")
  );
}
