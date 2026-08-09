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
import { danglingCitations, gitInRepo, readLedger, repoRoot, sha256File, sha256Text } from "./campaign.js";
import {
  GateStore,
  VERIFICATION_MECHANISM_PREFIX,
  normalizeMechanism,
  promotionsMissingFromProved,
  retractionClosure,
} from "./gates.js";
import { cliBackendCommand } from "./backends.js";
import {
  codexTransport,
  retryPolicy,
  ROLE_NAMES,
  roleModelSpec,
  specLabel,
} from "./providers.js";
import { sandboxMode, toolText } from "./supervise.js";

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
  extra: {
    harnessRev: string;
    launcherSha256: string;
    userAgentLimit?: number;
    maxWakes?: number;
    noComputation?: boolean;
    // Owned by harness.ts (its enforced constant); passed in rather than
    // re-derived here so the stamp cannot drift from the enforced value.
    coordinatorContextTokens: number;
  },
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
      fs.readdirSync(patchDir).map((f) => [f, sha256File(path.join(patchDir, f))]),
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
    transport: codexTransport(),
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
    let content: string;
    try {
      content = readLedger(dir, ledger);
    } catch {
      continue;
    }
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
 * Record and tool reply are one step by design, so a refusal site cannot
 * record-skip (the promotion site did, twice, before this shape).
 */
export function refuse(
  store: GateStore,
  site: "dispatch" | "verification" | "promotion",
  reason: string,
  fields: { mechanism?: string; revision?: string; role?: string; candidateHash?: string } = {},
): ReturnType<typeof toolText> {
  store.event({
    kind: "note",
    refusal: site,
    ...fields,
    reason: reason.slice(0, 300),
  });
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
  // Only the newest refusal per subject matters, and it is decided first so
  // superseded refusals never pay a follow-up scan: any follow-up that clears
  // the newest refusal lies after the older ones too.
  const subjectKey = (r: (typeof records)[number]): string | undefined => {
    if (r.refusal === "dispatch" && typeof r.mechanism === "string") {
      return `dispatch:${r.mechanism.toLowerCase()}`;
    }
    if ((r.refusal === "verification" || r.refusal === "promotion") && typeof r.revision === "string") {
      return `${r.refusal}:${r.revision.toLowerCase()}`;
    }
    return undefined;
  };
  const newest = new Map<string, number>();
  records.forEach((r, i) => {
    const k = subjectKey(r);
    if (k !== undefined) newest.set(k, i);
  });
  const out: { site: string; subject: string; reason: string }[] = [];
  records.forEach((r, i) => {
    const k = subjectKey(r);
    if (k === undefined || newest.get(k) !== i) return;
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
            e.mechanism.startsWith(VERIFICATION_MECHANISM_PREFIX) &&
            e.mechanism.slice(VERIFICATION_MECHANISM_PREFIX.length).toLowerCase() === rev) ||
          (e.kind === "promotion" && typeof e.revision === "string" && e.revision.toLowerCase() === rev) ||
          (typeof r.candidateHash === "string" &&
            (e.kind === "audit" || e.kind === "bundle-cert" || e.kind === "comparison") &&
            e.candidateHash === r.candidateHash),
      );
      if (!followed) out.push({ site: String(r.refusal), subject: r.revision, reason: String(r.reason ?? "") });
    }
  });
  return out.reverse(); // newest first
}

/**
 * Model substitutions (#21 P3): verdict records whose backend self-reported
 * or attested a model that disagrees with the requested spec. Journal-only
 * by design — the harness never refuses on mismatch (that would invent
 * policy, design rule 3); it surfaces the disagreement so a cross-family
 * guarantee cannot quietly become a same-family one. The hostile auditor is
 * the highest-value watch: its claude-cli call IS the cross-family check
 * behind every promotion.
 */
export function modelSubstitutions(
  store: GateStore,
): { kind: string; revision: string; requested: string; actual: string }[] {
  const out: { kind: string; revision: string; requested: string; actual: string }[] = [];
  for (const e of store.all()) {
    const actual = typeof e.reportedModel === "string" ? e.reportedModel : undefined;
    const requested = typeof e.modelFamily === "string" ? e.modelFamily : undefined;
    if (actual === undefined || requested === undefined || actual === requested) continue;
    // Same-provider model-id drift is the signal; a bare provider prefix
    // match is not enough (claude-cli/opus vs claude-cli/claude-opus-5 is
    // the CLI's canonical spelling of the same request, not a substitution).
    if (sameModelId(actual, requested)) continue;
    out.push({
      kind: String(e.kind),
      revision: String(e.revision ?? ""),
      requested,
      actual,
    });
  }
  return out;
}

/** Alias vs substitution. A CLI answers a short request name with its own
 *  canonical spelling (`opus` -> `claude-opus-5`), which is the same model;
 *  a router serving `gpt-5-5-mini` for `gpt-5-6-pro` is not. Comparing by
 *  prefix containment after stripping the provider and vendor prefix keeps
 *  aliases quiet and every real swap loud. */
function sameModelId(a: string, b: string): boolean {
  const canon = (label: string) =>
    label
      .slice(label.indexOf("/") + 1)
      .toLowerCase()
      .replace(/^claude-/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-latest$/, "");
  const [x, y] = [canon(a), canon(b)];
  return x.startsWith(y) || y.startsWith(x);
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
  const substitutions = modelSubstitutions(store);
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
    (substitutions.length > 0
      ? `\n\nMODEL SUBSTITUTIONS ON RECORD (a verdict backend answered with a model other than the ` +
        `one requested; a cross-family audit that ran same-family is weaker evidence than its label ` +
        `suggests — judge whether the affected verdict still carries the weight you gave it):\n` +
        substitutions
          .slice(-5)
          .map((s) => `- ${s.kind} ${s.revision}: requested ${s.requested}, answered ${s.actual}`)
          .join("\n")
      : "") +
    (unaddressed.length > 0
      ? `\n\nREFUSED WORK NOTHING FOLLOWED UP (re-propose deliberately or drop deliberately):\n` +
        unaddressed.map((r) => `- [${r.site}] ${r.subject}: ${r.reason.slice(0, 120)}`).join("\n")
      : "")
  );
}
