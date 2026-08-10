// Read-only consumer (design.md's view/ layer): what a campaign's tokens went
// on. Three refusals, each bought with an error from the 2026-08-09 study
// (docs/measurement-protocol.md): never cross-sum meters (the lanes bill
// different accounts, so one total is not a currency); never count a roll-up
// (verification completions used to sum their own stage records, and counting
// both inflated that study by 27%); never add reasoning to output (it is a
// SUBSET of output).
import type { Meter, RoleUsage } from "../providers.js";
import { M, runRecords } from "../view/shared.js";

/** One lane's totals. `input` is always the uncached part. */
export interface LaneSpend {
  meter: Meter | string;
  calls: number;
  input: number;
  cacheRead: number;
  output: number;
  /** Absent unless some record reported it (absent ≠ zero; see RoleUsage). */
  reasoning?: number;
  cacheWrite?: number;
}

export interface RoleSpend extends LaneSpend {
  role: string;
}

export interface CampaignSpend {
  /** Provider calls whose tokens cannot be measured at all, distinct from
   *  `excluded` (records a reader must SKIP). Both else read as zero. */
  unmetered: { lane: string; calls: number }[];
  byLane: LaneSpend[];
  byRole: RoleSpend[];
  /** Per (model, thinking level): `modelSpec` keeps the @thinking suffix that
   *  `modelFamily` drops, the grouping issue #31's effort A/B needs. */
  byModel: RoleSpend[];
  /** Records whose usage was skipped, and why, so a partial total shows. */
  excluded: { reason: string; records: number }[];
  /** True when any record carried a clamped (non-monotone) delta: real spend
   *  may be missing upstream. */
  nonMonotone: boolean;
}

/** Which role a usage-bearing record belongs to: `role` on coordinator events,
 *  the stage kind on verification records, the handle id's prefix on completions.
 *  DRIFT HAZARD: those prefixes are minted in coordinator-tools and nothing
 *  couples the two ends, so a new prefix lands in "other". */
/** Stage identity -> role name. Keyed by both the stage attribute a leaf
 *  inherits and the record `kind` a stage decision carries; they share spelling. */
const STAGE_ROLES: Record<string, string> = {
  audit: "auditor",
  "bundle-cert": "certifier",
  reconstruction: "reconstructor",
  comparison: "comparator",
};

export function roleOf(r: Record<string, unknown>): string {
  // `stage` before `role`: a verification leaf inherits role="verification"
  // from its dispatch, which would collapse all four stages into one row and
  // lose the per-stage gauge. The stage is the more specific fact.
  const stage = STAGE_ROLES[String(r.stage)];
  if (stage !== undefined) return stage;
  if (typeof r.role === "string") return r.role;
  const kind = String(r.kind);
  const byKind = STAGE_ROLES[kind];
  if (byKind !== undefined) return byKind;
  if (kind === "gate-verdict") return "gate-critic";
  if (kind === "role-call") return "orphaned-spend";
  const id = typeof r.id === "string" ? r.id : "";
  if (id.startsWith("r")) return "reasoner";
  if (id.startsWith("t")) return "technician";
  if (id.startsWith("g")) return "gate-critic";
  if (id.startsWith("v")) return "verification";
  return "other";
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Record kinds representing a provider call: a missing `usage` on one is a gap. */
const SPENDING_KINDS = new Set([
  "completion", "gate-verdict", "audit", "bundle-cert",
  "reconstruction", "comparison", "role-call", "usage",
]);

export function accumulate(into: LaneSpend, u: RoleUsage): void {
  into.calls += 1;
  into.input += u.input;
  into.cacheRead += u.cacheRead;
  into.output += u.output;
  // Optional fields stay absent until reported (absent ≠ zero; see RoleUsage).
  if (u.reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + u.reasoning;
  if (u.cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + u.cacheWrite;
}

/** Get-or-create one lane's bucket and add a record's usage. The seed omits
 *  `reasoning` and `cacheWrite` on purpose (absent ≠ zero) — share this rather
 *  than hand-writing a second seed, which breaks that silently (#43). */
export function bumpLane(lanes: Map<string, LaneSpend>, meter: LaneSpend["meter"], u: RoleUsage): void {
  const lane = lanes.get(meter) ?? { meter, calls: 0, input: 0, cacheRead: 0, output: 0 };
  accumulate(lane, u);
  lanes.set(meter, lane);
}

/** Row order only: summing input+output here ORDERS lanes, it never prints. */
export const bySpend = (a: LaneSpend, b: LaneSpend) => b.input + b.output - (a.input + a.output);

/** Which lane an unstamped (pre-2026-08-09) record came from, and whether its
 *  `input` is the uncached part. Rule 1's test: `cacheRead > input` is impossible
 *  when input INCLUDES cached, so one such record proves the role's lane
 *  disjoint. Measured: 0 of 925 codex-cli vs 45/53 coordinator, 193/193 auditor. */
export function inferLanes(records: readonly Record<string, unknown>[]): Map<string, string> {
  const disjoint = new Set<string>();
  const seen = new Set<string>();
  for (const r of records) {
    const u = r.usage as RoleUsage | undefined;
    if (!u || typeof u.input !== "number" || u.meter !== undefined) continue;
    const role = roleOf(r);
    seen.add(role);
    if (u.cacheRead > u.input) disjoint.add(role);
  }
  return new Map(
    [...seen].map((role) => [
      role,
      disjoint.has(role) ? `unstamped:${role} (disjoint)` : `unstamped:${role} (nested?)`,
    ]),
  );
}

export function campaignSpend(campaignDir: string, run?: string): CampaignSpend {
  const lanes = new Map<string, LaneSpend>();
  const roles = new Map<string, RoleSpend>();
  const models = new Map<string, RoleSpend>();
  const excluded = new Map<string, number>();
  let nonMonotone = false;
  // Filtered BEFORE lane inference, so a report on one run never labels its
  // lanes from a record it does not show.
  const { records } = runRecords(campaignDir, run);
  const lanes0 = inferLanes(records);
  const unmetered = new Map<string, number>();
  // A cancelled worker keeps running, so one dispatch can write TWO usage
  // records (cancel, then settle), both snapshots of the same CUMULATIVE total —
  // LAST wins. `note` counts too: a late artifact carries settle-time totals.
  const superseded = (r: Record<string, unknown>) =>
    (r.kind === "completion" || r.kind === "note") && typeof r.id === "string" && Boolean(r.usage);
  const lastCompletion = new Map<string, number>();
  records.forEach((r, i) => {
    if (superseded(r)) lastCompletion.set(r.id as string, i);
  });

  for (const [i, r] of records.entries()) {
    if (superseded(r) && lastCompletion.get(r.id as string) !== i) {
      bump(excluded, "superseded completion for a cancelled dispatch (same session's cumulative total)");
      continue;
    }
    if (typeof r.unmetered === "string") {
      bump(unmetered, r.unmetered);
      continue;
    }
    // Flagged roll-ups (post-7bd75d5).
    if (r.usageRollup === true) {
      bump(excluded, "roll-up of records already counted");
      continue;
    }
    // Historical roll-ups carry no flag: verification completions before 7bd75d5
    // summed their own stage records, also on file, and every campaign on disk is
    // in that era (the 80.4M-token, 27% inflation). `runId` marks a post-deletion
    // record, which carries no sum.
    if (r.runId === undefined && r.kind === "completion" && typeof r.id === "string" && /^v\d/.test(r.id)) {
      bump(excluded, "verification roll-up, unflagged (pre-7bd75d5 record)");
      continue;
    }
    // Pre-per-wake-leaf records carry a running session total: summing
    // snapshots multiplies them, and max() per (runId, sessionId) is a
    // different query — say so, don't guess.
    if (r.cumulative !== undefined) {
      bump(excluded, "cumulative snapshot (pre-leaf coordinator record)");
      continue;
    }
    const u = r.usage as RoleUsage | undefined;
    if (!u || typeof u.input !== "number") {
      // Only records that COULD carry usage count as a gap: a verification or
      // gate completion is EMPTY BY DESIGN, its spend leafed by the stage
      // records underneath, so counting them reports phantom unmeasured calls.
      const leafedElsewhere =
        r.kind === "completion" && typeof r.id === "string" && /^[vg]\d/.test(r.id);
      if (SPENDING_KINDS.has(String(r.kind)) && !leafedElsewhere) {
        bump(excluded, "provider call that reported no usage (unmetered lane, or a reject before parse)");
      }
      continue;
    }
    if ((u as { nonMonotone?: boolean }).nonMonotone) nonMonotone = true;

    // An unstamped record's lane is inferred and labelled so: its `input` may
    // be the nested kind, not comparable with a disjoint lane's.
    const meter = (u.meter ?? lanes0.get(roleOf(r)) ?? "unstamped") as LaneSpend["meter"];
    bumpLane(lanes, meter, u);

    // Not bumpLane: keyed by role AND meter, and carries the role on the row.
    const role = roleOf(r);
    const key = `${role} ${meter}`;
    const byRole = roles.get(key) ?? { role, meter, calls: 0, input: 0, cacheRead: 0, output: 0 };
    accumulate(byRole, u);
    roles.set(key, byRole);

    // A record naming no spec is grouped as such, not dropped, so these rows
    // sum to the same total as byRole.
    const spec = typeof r.modelSpec === "string" ? r.modelSpec : "(no modelSpec on record)";
    const mKey = `${spec} ${meter}`;
    const byModel = models.get(mKey) ?? { role: spec, meter, calls: 0, input: 0, cacheRead: 0, output: 0 };
    accumulate(byModel, u);
    models.set(mKey, byModel);
  }

  return {
    byLane: [...lanes.values()].sort(bySpend),
    byModel: [...models.values()].sort(bySpend),
    byRole: [...roles.values()].sort(bySpend),
    excluded: [...excluded].map(([reason, records]) => ({ reason, records })),
    unmetered: [...unmetered].map(([lane, calls]) => ({ lane, calls })),
    nonMonotone,
  };
}

/** Per-lane subtotals and NO grand total, which would be a cross-meter sum. */
export function formatSpend(s: CampaignSpend): string {
  const W = 34;
  const lane = (s: string) => (s.length > W ? `${s.slice(0, W - 1)}…` : s).padEnd(W);
  const opt = (n?: number) => (n === undefined ? "—" : M(n));
  const out: string[] = [];
  out.push("by lane — lanes bill to different provider accounts, so they are never summed.");
  out.push("`fresh in` is the uncached part EXCEPT on rows marked (nested?), where the");
  out.push("pre-2026-08-09 record may fold cached tokens into it. Those are not comparable.");
  out.push(
    `  ${"lane".padEnd(W)}${"calls".padStart(7)}${"fresh in".padStart(10)}${"cached in".padStart(11)}${"output".padStart(9)}${"reasoning".padStart(11)}${"cache wr".padStart(10)}`,
  );
  for (const l of s.byLane) {
    out.push(
      `  ${lane(l.meter)}${String(l.calls).padStart(7)}${M(l.input).padStart(10)}` +
        `${M(l.cacheRead).padStart(11)}${M(l.output).padStart(9)}${opt(l.reasoning).padStart(11)}${opt(l.cacheWrite).padStart(10)}`,
    );
  }
  out.push("");
  out.push("by role");
  for (const r of s.byRole) {
    out.push(
      `  ${r.role.padEnd(16)}${lane(r.meter)}${String(r.calls).padStart(6)}` +
        `${M(r.input).padStart(10)}${M(r.cacheRead).padStart(11)}${M(r.output).padStart(9)}${opt(r.reasoning).padStart(11)}`,
    );
  }

  out.push("");
  out.push("by model spec (@thinking included — the grouping an effort A/B needs)");
  for (const m of s.byModel) {
    out.push(
      `  ${m.role.padEnd(30)}${lane(m.meter)}${String(m.calls).padStart(6)}` +
        `${M(m.input).padStart(10)}${M(m.cacheRead).padStart(11)}${M(m.output).padStart(9)}${opt(m.reasoning).padStart(11)}`,
    );
  }

  // Floors: a row whose lane never reports a field is a LOWER BOUND on that
  // column; rule 10 forbids presenting a gap as a measurement.
  const noReasoning = s.byLane.filter((l) => l.reasoning === undefined).map((l) => String(l.meter));
  // Absent OR an exact zero across many calls: historical records carry a
  // literal 0 from a broken meter.
  const noCacheWrite = s.byLane
    .filter((l) => l.cacheWrite === undefined || (l.cacheWrite === 0 && l.calls > 1))
    .map((l) => String(l.meter));
  if (noReasoning.length > 0 || noCacheWrite.length > 0) {
    out.push("");
    out.push("floors — these rows are LOWER BOUNDS, not measurements:");
    if (noReasoning.length > 0) {
      out.push(`  reasoning unreported by: ${noReasoning.join(", ")}`);
      out.push("    (the claude-cli result JSON carries no thinking-token field at all)");
    }
    if (noCacheWrite.length > 0) {
      out.push(`  cacheWrite unreported by: ${noCacheWrite.join(", ")}`);
      // An interval, not a point estimate, which would read as a measurement.
      out.push("    Cache writes are real spend billed at 1.25x input on the API lane and are");
      out.push("    absent upstream on the codex lanes (codex #32479, pi #6469). The audit lane,");
      out.push("    which reports both, measured write/read between 0.25 and 2.5 — so bound an");
      out.push("    unreported row by 0.25-2.5x its cached-in column rather than treating it as 0.");
    }
  }
  if (s.excluded.length > 0) {
    out.push("");
    out.push("excluded (counted would be wrong, not missing):");
    for (const e of s.excluded) out.push(`  ${String(e.records).padStart(5)}  ${e.reason}`);
  }
  if (s.unmetered.length > 0) {
    out.push("");
    out.push("UNMETERED — real spend nobody can count, not spend that was zero:");
    for (const u of s.unmetered) out.push(`  ${String(u.calls).padStart(5)}  ${u.lane}`);
  }
  // Rule 1's diagnostic; it located the 30% overstatement in the 2026-08-09
  // study, so run it first when numbers look wrong.
  const disjoint = s.byRole.filter((r) => r.cacheRead > r.input);
  if (disjoint.length > 0) {
    out.push("");
    out.push("convention diagnostic (rule 1): roles where cached in > fresh in, which is");
    out.push("impossible unless `input` EXCLUDES cached — i.e. the disjoint convention:");
    for (const r of disjoint) out.push(`  ${r.role.padEnd(16)}${String(r.meter)}`);
  }
  if (s.nonMonotone) {
    out.push("");
    out.push("WARNING: a record carried a clamped delta (nonMonotone). Real spend may be");
    out.push("missing upstream of this reader — see docs/measurement-protocol.md rule 2.");
  }
  out.push("");
  out.push("No grand total, deliberately: summing across lanes is not a currency.");
  out.push("Nor is any of this the binding constraint: subscription runs are metered by");
  out.push("a rolling window, not by tokens or dollars, and a campaign that fits a");
  out.push("month's spend can still die in an afternoon. Run `coverify limits` for the");
  out.push("occupancy and burn rate that actually end campaigns.");
  return out.join("\n");
}
