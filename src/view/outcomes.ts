// Read-only consumer (design.md's view/ layer): what the campaign's spend
// BOUGHT, as opposed to what it cost. Every cost metric in the 2026-08-09
// study died for lack of an outcome term (docs/measurement-protocol.md rules
// 7 and 8: a cost-side number alone is non-diagnostic, and cost-per-claim is
// never comparable across systems). This is the outcome side, and it needs no
// recorded field that is not already on disk.
//
// It reports what stage records can actually support, and refuses the one
// thing they cannot. Issue #38's headline instrument — the fraction of
// promotions on the answer's dependency path — is NOT here, because the
// premise edge it walks is `Type.Optional` and 54 of 64 promotions across all
// seven campaigns carry none. Computing it anyway would return ~0 everywhere
// and measure the unrecorded edge rather than the misdirected work.
import { GateStore } from "../gates.js";
import type { RoleUsage } from "../providers.js";
import { type LaneSpend, bumpLane, bySpend } from "./spend.js";

/** The four verification stages plus the pre-verification gate. A stage record
 *  carries `verdict`, so a FAIL rate is a count, not an inference. */
const STAGES = ["gate-verdict", "audit", "bundle-cert", "reconstruction", "comparison"] as const;

export interface StageOutcome {
  stage: string;
  verdicts: { verdict: string; count: number }[];
  total: number;
}

export interface RevisionOutcome {
  revision: string;
  /** Verification rounds this revision went through — the repair loop's depth. */
  rounds: number;
  verdicts: string[];
  promoted: boolean;
}

export interface CampaignOutcomes {
  stages: StageOutcome[];
  /** Revisions that entered verification, and what became of them. */
  revisions: RevisionOutcome[];
  promoted: number;
  /** Verification spend on revisions that never promoted, per lane. Lanes are
   *  never summed, for the reason view/spend.ts refuses to sum them. */
  unpromotedSpend: LaneSpend[];
  promotedSpend: LaneSpend[];
  /** Revisions promoted without any stage record naming them — a promotion the
   *  verification cadence never saw. Reported, never silently folded in. */
  promotedWithoutVerification: string[];
}

/** Revision identity is case-insensitive everywhere else in this codebase
 *  (gates.ts sameRevision), so two case spellings of one file are one
 *  revision here too. */
const key = (s: unknown) => String(s).toLowerCase();

export function campaignOutcomes(campaignDir: string, run?: string): CampaignOutcomes {
  const store = new GateStore(campaignDir);
  const records = (store.all() as unknown as Record<string, unknown>[]).filter(
    (r) => run === undefined || r.runId === run,
  );

  const promoted = new Set(records.filter((r) => r.kind === "promotion").map((r) => key(r.revision)));

  const stages: StageOutcome[] = [];
  const perRevision = new Map<string, { rounds: number; verdicts: string[]; label: string }>();
  const unpromoted = new Map<string, LaneSpend>();
  const promotedLanes = new Map<string, LaneSpend>();

  for (const stage of STAGES) {
    const rows = records.filter((r) => r.kind === stage);
    if (rows.length === 0) continue;
    const counts = new Map<string, number>();
    for (const r of rows) {
      // A stage record with no verdict is a stage that ran and reported
      // nothing — kept as its own bucket rather than dropped, so the totals
      // reconcile against the record count.
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
    // they cannot be attributed to a revision at all. Counted in the stage
    // table above, absent from the per-revision table below — a gap that is
    // visible rather than papered over with a fuzzy mechanism-string match.
    if (typeof r.revision !== "string") continue;
    const k = key(r.revision);
    const e = perRevision.get(k) ?? { rounds: 0, verdicts: [], label: r.revision };
    e.rounds += 1;
    if (typeof r.verdict === "string") e.verdicts.push(r.verdict);
    perRevision.set(k, e);
    const u = r.usage as RoleUsage | undefined;
    if (u && typeof u.input === "number") {
      bumpLane(promoted.has(k) ? promotedLanes : unpromoted, (u.meter ?? "unstamped") as LaneSpend["meter"], u);
    }
  }

  return {
    stages,
    revisions: [...perRevision]
      .map(([k, e]) => ({ revision: e.label, rounds: e.rounds, verdicts: e.verdicts, promoted: promoted.has(k) }))
      .sort((a, b) => b.rounds - a.rounds),
    promoted: promoted.size,
    unpromotedSpend: [...unpromoted.values()].sort(bySpend),
    promotedSpend: [...promotedLanes.values()].sort(bySpend),
    promotedWithoutVerification: [...promoted].filter((p) => !perRevision.has(p)),
  };
}

export function formatOutcomes(o: CampaignOutcomes): string {
  const M = (n: number) => `${(n / 1e6).toFixed(2)}M`;
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
  out.push(`  ${String(o.promoted).padStart(5)}  promoted`);
  if (verified > 0) {
    const never = o.revisions.filter((r) => !r.promoted).length;
    out.push(`  ${String(never).padStart(5)}  verified and never promoted (${((never / verified) * 100).toFixed(0)}%)`);
    const rounds = o.revisions.map((r) => r.rounds).sort((a, b) => a - b);
    const median = rounds[Math.floor(rounds.length / 2)];
    out.push(`  ${String(median).padStart(5)}  median verification rounds per revision (max ${rounds[rounds.length - 1]})`);
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
      out.push("  (none)");
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
  out.push("summed: they bill to different accounts (see coverify spend).");
  out.push("");
  out.push("NOT reported: the on-path fraction of issue #38. It walks promotion premises,");
  out.push("which are optional and absent on 54 of 64 promotions campaign-wide, so the");
  out.push("number would measure the missing edge rather than the misdirected work.");
  return out.join("\n");
}
