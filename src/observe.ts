/**
 * Observability, separated from operations (Chao, 2026-08-08): everything
 * here RECORDS what happened or NOTICES what the records imply. It
 * generates prompt text and records, and never itself gates, dispatches,
 * schedules, or writes ledgers. The boundary criterion with harness.ts:
 * anything derived from durable history (journal, ledgers, gate records)
 * belongs here; anything derived from the process's live scheduler state
 * (handles, queues, wake counters) stays in the harness. House rule from
 * the 2026-08-08 review (issue #21): every record ships with the derived
 * query that makes it actionable — an unread log is not an audit trail.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { danglingCitations, gitInRepo, readLedger, repoRoot, sha256Text } from "./campaign.js";
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
  toolText,
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
  const repo = repoRoot();
  const piVersion = (pkg: string): string | undefined => {
    try {
      const p = path.join(repo, "node_modules", "@earendil-works", pkg, "package.json");
      return (JSON.parse(fs.readFileSync(p, "utf-8")) as { version?: string }).version;
    } catch {
      return undefined;
    }
  };
  // Tri-state: a failed git probe must not masquerade as a dirty tree.
  const gitStatus = gitInRepo("git status --porcelain");
  const patchDir = path.join(repo, "patches");
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
    gitDirty: gitStatus === undefined ? "unknown" : gitStatus !== "",
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
    const last = store.all().findLast((e) => e.ledgerRevision === ledger);
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
  site: "dispatch" | "verification" | "promotion",
  fields: { reason: string; mechanism?: string; revision?: string; role?: string; candidateHash?: string },
): void {
  store.event({
    kind: "note",
    refusal: site,
    ...fields,
    reason: fields.reason.slice(0, 300),
  });
}

/**
 * Record a refusal and produce the tool reply in one step — the idiom every
 * refusal site shares, factored so the next site cannot record-skip (the
 * promotion site did, on the first pass).
 */
export function refuse(
  store: GateStore,
  site: "dispatch" | "verification" | "promotion",
  reason: string,
  fields: { mechanism?: string; revision?: string; role?: string; candidateHash?: string } = {},
): ReturnType<typeof toolText> {
  recordRefusal(store, site, { reason, ...fields });
  return toolText(`${site.toUpperCase()} REFUSED: ${reason}`);
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
    // Index-bounded scans (no per-refusal array copy).
    const after = (pred: (e: (typeof records)[number]) => boolean) =>
      records.some((e, j) => j > i && pred(e));
    if (r.refusal === "dispatch" && typeof r.mechanism === "string") {
      const key = normalizeMechanism(r.mechanism);
      const followed = after(
        (e) => e.kind === "dispatch" && typeof e.mechanism === "string" && normalizeMechanism(e.mechanism) === key,
      );
      if (!followed) out.push({ site: "dispatch", subject: r.mechanism, reason: String(r.reason ?? "") });
    } else if (typeof r.revision === "string" && (r.refusal === "verification" || r.refusal === "promotion")) {
      const rev = r.revision.toLowerCase();
      // Follow-up by name OR by content: a refused candidate re-verified
      // under a new filename (same bytes) must clear the flag, so stage
      // records' candidateHash counts as follow-up too. A refused promotion
      // is cleared by a later promotion or any later verification activity
      // on the revision.
      const followed = after(
        (e) =>
          (e.kind === "dispatch" &&
            typeof e.mechanism === "string" &&
            e.mechanism.startsWith("verification:") &&
            e.mechanism.slice("verification:".length).toLowerCase() === rev) ||
          (e.kind === "promotion" && typeof e.revision === "string" && e.revision.toLowerCase() === rev) ||
          (typeof r.candidateHash === "string" &&
            (e.kind === "audit" || e.kind === "bundle-cert" || e.kind === "comparison") &&
            e.candidateHash === r.candidateHash),
      );
      if (!followed) out.push({ site: String(r.refusal), subject: r.revision, reason: String(r.reason ?? "") });
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
