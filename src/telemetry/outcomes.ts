// Read-only consumer: what the campaign's spend BOUGHT, as opposed to what it
// cost. Reports what stage records can support and refuses what they cannot —
// see onPathFraction. Cost metrics are non-diagnostic of research output: the
// system that won every cost metric in the 2026-08-09 study resolved nothing.
import { promotionsNeedingRetraction } from "../gates.js";
import type { RoleUsage } from "../providers.js";
import { M, median, runRecords } from "./shared.js";
import { type LaneSpend, bumpLane, bySpend, inferLanes, roleOf } from "./spend.js";

/** A stage record carries `verdict`, so a FAIL rate is a count, not an inference. */
const STAGES = ["gate-verdict", "audit", "bundle-cert", "reconstruction", "comparison"] as const;

export interface StageOutcome {
  stage: string;
  verdicts: { verdict: string; count: number }[];
  total: number;
}

export interface RevisionOutcome {
  revision: string;
  /** Verification rounds: the repair loop's depth. */
  rounds: number;
  verdicts: string[];
  promoted: boolean;
}

export interface CampaignOutcomes {
  stages: StageOutcome[];
  revisions: RevisionOutcome[];
  promoted: number;
  /** Promotions contradicted by a later substantive FAIL. Excluded from
   *  `promoted` and from promoted spend, reported here so the exclusion is
   *  visible. */
  retracted: string[];
  /** Verification spend on revisions that never promoted, per lane. Never
   *  summed across lanes, for spend.ts's reason. */
  unpromotedSpend: LaneSpend[];
  promotedSpend: LaneSpend[];
  /** Stage records whose spend joined to no role-call leaf. Non-zero with empty
   *  spend tables means the measurement is MISSING, not zero (rule 10) — the
   *  usual cause is a campaign run with the telemetry extension off. */
  unjoinedStages: number;
  /** Revisions promoted without any stage record naming them — a promotion the
   *  verification cadence never saw. Reported, never silently folded in. */
  promotedWithoutVerification: string[];
  /** Issue #38's instrument: of the standing promotions, how many lie on the
   *  transitive premise path of a terminal result. `fraction` is present ONLY
   *  when the premise graph can carry the question (see onPathFraction). */
  onPath: {
    promotions: number;
    /** Promotions carrying at least one machine-resolvable premise. */
    withPremises: number;
    edges: number;
    /** Terminal results: promotions no other promotion depends on. */
    terminals: number;
    onPath?: number;
    fraction?: number;
    refusal?: string;
  };
}

/** Revision identity is case-insensitive codebase-wide (gates.ts
 *  sameRevision), so two case spellings of one file are one revision. */
const key = (s: unknown) => String(s).toLowerCase();

/** Issue #38: of the work that promoted, how much lies on the dependency path
 *  of a result? Walks `premises` backwards from terminal results, and REFUSES
 *  to divide below 50% premise coverage — on the seven campaigns measured
 *  2026-08-09 only 10 of 64 promotions carried a premise, so the rest are
 *  isolated nodes trivially their own terminal and the fraction comes out ~1.0
 *  meaning "nothing was recorded". */
function onPathFraction(
  promotions: { revision: string; premises: string[] }[],
): CampaignOutcomes["onPath"] {
  const withPremises = promotions.filter((p) => p.premises.length > 0).length;
  const edges = promotions.reduce((n, p) => n + p.premises.length, 0);
  const isPremise = new Set(promotions.flatMap((p) => p.premises.map(key)));
  const terminals = promotions.filter((p) => !isPremise.has(key(p.revision)));
  const base = { promotions: promotions.length, withPremises, edges, terminals: terminals.length };

  if (promotions.length === 0) return { ...base, refusal: "no promotions" };
  // Coverage, not edge count: what share could be placed on or off a path.
  const coverage = withPremises / promotions.length;
  if (coverage < 0.5) {
    return {
      ...base,
      refusal:
        `only ${withPremises} of ${promotions.length} promotions carry a machine-resolvable premise ` +
        `(${(coverage * 100).toFixed(0)}%), so most are isolated nodes that are trivially their own ` +
        "terminal. A fraction computed here would measure the unrecorded edge, not the misdirected work",
    };
  }
  const byRev = new Map(promotions.map((p) => [key(p.revision), p]));
  const seen = new Set<string>();
  const queue = terminals.map((t) => key(t.revision));
  while (queue.length > 0) {
    const r = queue.pop()!;
    if (seen.has(r)) continue;
    seen.add(r);
    for (const pr of byRev.get(r)?.premises ?? []) queue.push(key(pr));
  }
  return { ...base, onPath: seen.size, fraction: seen.size / promotions.length };
}

/** A cadence dispatch runs several stages, so the leaf key is the pair. */
const joinKey = (dispatchId: unknown, stage: unknown) => `${String(dispatchId)}\u0000${String(stage)}`;

/** Stage-attributed spend, plus the dispatch-level spend that names no stage.
 *
 *  The second bucket is why this is not one map. `flushErrorSpend` and
 *  `flushUnrecordedSpend` write a `role-call` carrying `dispatchId` but no
 *  `stage` — a cadence billed and then failed. Fanning those across every stage
 *  the dispatch recorded counted a single payment FOUR TIMES in a reader whose
 *  stated discipline is never to double-count, so they are attributed once, to
 *  the dispatch. */
function leavesByStage(records: readonly Record<string, unknown>[]): {
  byStage: Map<string, RoleUsage[]>;
  byDispatch: Map<string, RoleUsage[]>;
} {
  const byStage = new Map<string, RoleUsage[]>();
  const byDispatch = new Map<string, RoleUsage[]>();
  const push = (m: Map<string, RoleUsage[]>, k: string, u: RoleUsage) =>
    m.set(k, [...(m.get(k) ?? []), u]);
  for (const r of records) {
    if (r.kind !== "role-call" || typeof r.dispatchId !== "string") continue;
    const u = r.usage as RoleUsage | undefined;
    if (!u || typeof u.input !== "number") continue;
    if (typeof r.stage === "string") push(byStage, joinKey(r.dispatchId, r.stage), u);
    else push(byDispatch, r.dispatchId, u);
  }
  return { byStage, byDispatch };
}

export function campaignOutcomes(campaignDir: string, run?: string): CampaignOutcomes {
  const { store, records } = runRecords(campaignDir, run);

  // A promotion contradicted by a later substantive FAIL is not an outcome;
  // counting it errs in the flattering direction.
  const retracted = new Set(promotionsNeedingRetraction(store).map((r) => key(r.revision)));
  const promoted = new Set(
    records
      .filter((r) => r.kind === "promotion" && !retracted.has(key(r.revision)))
      .map((r) => key(r.revision)),
  );
  // The SAME lane inference spend.ts uses, never a second rule: bucketing on
  // `u.meter ?? "unstamped"` mixes nested and disjoint `input` in one row and
  // prints unmeasured fresh input as a measured 0.00M (rules 1 and 10).
  const lanes0 = inferLanes(records);

  const stages: StageOutcome[] = [];
  const perRevision = new Map<string, { rounds: number; verdicts: string[]; label: string }>();
  const unpromoted = new Map<string, LaneSpend>();
  const promotedLanes = new Map<string, LaneSpend>();
  const { byStage: leafSpend, byDispatch: dispatchSpend } = leavesByStage(records);
  // Dispatch-level spend is claimed by the FIRST stage record of that dispatch,
  // so it lands in the promoted/unpromoted split exactly once.
  const claimedDispatches = new Set<string>();
  // Stage records whose spend could not be found on either side of the split.
  // Counted so an empty spend table can say WHY it is empty (rule 10).
  let unjoined = 0;

  for (const stage of STAGES) {
    const rows = records.filter((r) => r.kind === stage);
    if (rows.length === 0) continue;
    const counts = new Map<string, number>();
    for (const r of rows) {
      // A stage that reported nothing keeps its own bucket, so totals reconcile
      // against the record count.
      const v = typeof r.verdict === "string" ? r.verdict : "(no verdict recorded)";
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    stages.push({
      stage,
      total: rows.length,
      verdicts: [...counts].map(([verdict, count]) => ({ verdict, count })).sort((a, b) => b.count - a.count),
    });
  }

  for (const r of records) {
    if (!STAGES.includes(r.kind as (typeof STAGES)[number])) continue;
    // gate-verdict records carry `mechanism`, never `revision` (issue #36), so
    // they appear in the stage table but not the per-revision one.
    if (typeof r.revision !== "string") continue;
    const k = key(r.revision);
    const e = perRevision.get(k) ?? { rounds: 0, verdicts: [], label: r.revision };
    e.rounds += 1;
    if (typeof r.verdict === "string") e.verdicts.push(r.verdict);
    perRevision.set(k, e);
    // Spend comes from role-call leaves joined on dispatchId, never off the
    // stage record: a stage record is a DECISION and carries no tokens. The
    // legacy branch reads `r.usage` for campaigns recorded before that split.
    const legacy = r.usage as RoleUsage | undefined;
    let spends: RoleUsage[];
    if (legacy && typeof legacy.input === "number") {
      spends = [legacy];
    } else {
      spends = [...(leafSpend.get(joinKey(r.dispatchId, r.kind)) ?? [])];
      const id = typeof r.dispatchId === "string" ? r.dispatchId : undefined;
      if (id !== undefined && !claimedDispatches.has(id)) {
        claimedDispatches.add(id);
        spends.push(...(dispatchSpend.get(id) ?? []));
      }
    }
    for (const u of spends) {
      const meter = (u.meter ?? lanes0.get(roleOf(r)) ?? "unstamped") as LaneSpend["meter"];
      bumpLane(promoted.has(k) ? promotedLanes : unpromoted, meter, u);
    }
    if (spends.length === 0) unjoined += 1;
  }

  return {
    stages,
    revisions: [...perRevision]
      .map(([k, e]) => ({ revision: e.label, rounds: e.rounds, verdicts: e.verdicts, promoted: promoted.has(k) }))
      .sort((a, b) => b.rounds - a.rounds),
    promoted: promoted.size,
    retracted: [...retracted],
    unpromotedSpend: [...unpromoted.values()].sort(bySpend),
    promotedSpend: [...promotedLanes.values()].sort(bySpend),
    unjoinedStages: unjoined,
    promotedWithoutVerification: [...promoted].filter((p) => !perRevision.has(p)),
    // Standing promotions only: a retracted one is neither a terminal nor on
    // anything's path.
    onPath: onPathFraction(
      records
        .filter((r) => r.kind === "promotion" && promoted.has(key(r.revision)))
        .map((r) => ({
          revision: String(r.revision),
          premises: (Array.isArray(r.premises) ? r.premises : []).map(String),
        })),
    ),
  };
}

export function formatOutcomes(o: CampaignOutcomes): string {
  const out: string[] = [];
  out.push("stage verdicts — what the verification cadence actually decided");
  for (const s of o.stages) {
    const parts = s.verdicts.map((v) => `${v.verdict} ${v.count}`).join("  ");
    out.push(`  ${s.stage.padEnd(15)}${String(s.total).padStart(5)}   ${parts}`);
  }

  const verified = o.revisions.length;
  out.push("");
  out.push("revisions");
  out.push(`  ${String(verified).padStart(5)}  entered verification`);
  out.push(`  ${String(o.promoted).padStart(5)}  promoted (standing; retractions excluded)`);
  if (o.retracted.length > 0) {
    out.push(`  ${String(o.retracted.length).padStart(5)}  promoted then contradicted by a later FAIL — NOT counted above`);
  }
  if (verified > 0) {
    const never = o.revisions.filter((r) => !r.promoted).length;
    out.push(`  ${String(never).padStart(5)}  verified and never promoted (${((never / verified) * 100).toFixed(0)}%)`);
    const rounds = o.revisions.map((r) => r.rounds).sort((a, b) => a - b);
    out.push(
      `  ${String(median(rounds)).padStart(5)}  median verification rounds per revision ` +
        `(max ${rounds[rounds.length - 1]})`,
    );
  }
  if (o.promotedWithoutVerification.length > 0) {
    out.push(
      `  ${String(o.promotedWithoutVerification.length).padStart(5)}  promoted with NO stage record naming them`,
    );
  }

  const lanes = (title: string, rows: LaneSpend[]) => {
    out.push("");
    out.push(title);
    if (rows.length === 0) {
      // "(none)" would read as "this cost nothing". Say which it is (rule 10).
      out.push(
        o.unjoinedStages > 0
          ? `  NOT MEASURED — ${o.unjoinedStages} stage record(s) joined to no role-call leaf. ` +
            "Spend lives on leaves written by the telemetry extension; a campaign run without it " +
            "keeps every verdict and records no tokens."
          : "  (none — no stage record fell in this bucket)",
      );
      return;
    }
    for (const l of rows) {
      out.push(
        `  ${String(l.meter).padEnd(20)}${String(l.calls).padStart(6)} calls${M(l.input).padStart(10)} fresh in` +
          `${M(l.cacheRead).padStart(10)} cached${M(l.output).padStart(9)} out`,
      );
    }
  };
  lanes("verification spend on revisions that DID promote", o.promotedSpend);
  lanes("verification spend on revisions that never promoted", o.unpromotedSpend);

  out.push("");
  out.push("Stage spend only — the reasoner work that produced these revisions is not");
  out.push("attributed here, because a dispatch record names no revision. Lanes are not");
  out.push("summed, and neither are the two tables against each other: they bill to");
  out.push("different accounts, and a (nested?) row's `fresh in` may include cached");
  out.push("tokens that a (disjoint) row's excludes. Compare a lane with itself across");
  out.push("the two tables; that comparison is the one this reader supports.");
  out.push("A 0.00M `fresh in` on a disjoint lane is a lane billed entirely at the");
  out.push("cached rate, not a lane that spent nothing (see coverify spend's floors).");
  out.push("");
  const op = o.onPath;
  out.push("on-path fraction (issue #38) — of the work that promoted, how much lies on");
  out.push("the dependency path of a result?");
  out.push(
    `  ${op.promotions} standing promotion(s), ${op.withPremises} carrying a premise, ` +
      `${op.edges} edge(s), ${op.terminals} terminal result(s)`,
  );
  if (op.fraction !== undefined) {
    out.push(`  on path: ${op.onPath}/${op.promotions} = ${(op.fraction * 100).toFixed(0)}%`);
  } else {
    out.push(`  REFUSED: ${op.refusal}.`);
    out.push("  This is the instrument, not its absence: it returns a number the moment the");
    out.push("  premise edge is recorded, and refuses one until then.");
  }
  return out.join("\n");
}
