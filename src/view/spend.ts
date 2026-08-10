// Read-only consumer (design.md's view/ layer): what a campaign's tokens went
// on. The journal's usage fields were write-only for the project's whole
// history — providers.ts says "nothing reads this except the journal" — and
// write-only fields are untested fields, which is why one analysis found
// defects in most of them at once. This is the reader that exercises them.
//
// Three refusals, each purchased with a specific error from the 2026-08-09
// study (docs/measurement-protocol.md):
//   - never cross-sum meters: `input` is the uncached part on every lane, but
//     the lanes bill against different accounts, so one total is not a currency
//   - never count a roll-up: a verification completion used to carry a sum of
//     its own stage records, and counting both inflated that study by 27%
//   - never add reasoning to output: reasoning is a SUBSET of output (pi's
//     Usage contract), so adding it double-counts
import { GateStore } from "../gates.js";
import type { Meter, RoleUsage } from "../providers.js";

/** One lane's totals. `input` is always the uncached part. */
export interface LaneSpend {
  meter: Meter | string;
  calls: number;
  input: number;
  cacheRead: number;
  output: number;
  /** Absent unless some record in this lane reported it — a lane whose backend
   *  never reports reasoning is not a lane that reasoned zero. */
  reasoning?: number;
  cacheWrite?: number;
}

export interface RoleSpend extends LaneSpend {
  role: string;
}

export interface CampaignSpend {
  /** Provider calls whose tokens this harness cannot measure at all — an
   *  external agent or an oracle lane with no usage payload. Reported
   *  separately from `excluded`: those are records a reader must SKIP, these
   *  are spend nobody can count. Both would otherwise read as zero. */
  unmetered: { lane: string; calls: number }[];
  byLane: LaneSpend[];
  byRole: RoleSpend[];
  /** Records whose usage was skipped, and why. Reported rather than silently
   *  dropped: a reader must be able to see that a total is partial. */
  excluded: { reason: string; records: number }[];
  /** True when any record carried a clamped (non-monotone) delta — real spend
   *  may be missing upstream of this reader. */
  nonMonotone: boolean;
}

/** Which role a usage-bearing record belongs to. The journal names it three
 *  ways depending on the record kind, none of which is wrong — `role` on
 *  coordinator events, the stage kind on verification records, and the handle
 *  id's prefix on completions.
 *
 *  DRIFT HAZARD: the id prefixes below are minted elsewhere (coordinator-tools
 *  writes `${isTechnician ? "t" : "r"}NNN`), and nothing couples the two ends —
 *  a new prefix silently lands every record of that role in "other" instead of
 *  failing. Read-only view, so the cost is a mislabelled row, never a wrong
 *  campaign decision. */
function roleOf(r: Record<string, unknown>): string {
  if (typeof r.role === "string") return r.role;
  const kind = String(r.kind);
  if (kind === "gate-verdict") return "gate-critic";
  if (kind === "audit") return "auditor";
  if (kind === "bundle-cert") return "certifier";
  if (kind === "reconstruction") return "reconstructor";
  if (kind === "comparison") return "comparator";
  if (kind === "role-call") return "orphaned-spend";
  const id = typeof r.id === "string" ? r.id : "";
  if (id.startsWith("r")) return "reasoner";
  if (id.startsWith("t")) return "technician";
  if (id.startsWith("g")) return "gate-critic";
  if (id.startsWith("v")) return "verification";
  return "other";
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Record kinds that represent a provider call, so a missing `usage` on one is
 *  a measurement gap rather than a record that never spent anything. */
const SPENDING_KINDS = new Set([
  "completion", "gate-verdict", "audit", "bundle-cert",
  "reconstruction", "comparison", "role-call", "usage",
]);

export function accumulate(into: LaneSpend, u: RoleUsage): void {
  into.calls += 1;
  into.input += u.input;
  into.cacheRead += u.cacheRead;
  into.output += u.output;
  // Optional fields stay absent until some record reports one, so "no backend
  // measured this" never renders as a measured zero.
  if (u.reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + u.reasoning;
  if (u.cacheWrite !== undefined) into.cacheWrite = (into.cacheWrite ?? 0) + u.cacheWrite;
}

/** Get-or-create one lane's bucket and add a record's usage to it. The seed
 *  omits `reasoning` and `cacheWrite` on purpose (see accumulate): an absent
 *  field must never render as a measured zero. One copy, shared with
 *  view/outcomes.ts, for the reason accumulate() itself is shared — a second
 *  hand-written seed is where that rule gets broken silently (issue #43). */
export function bumpLane(lanes: Map<string, LaneSpend>, meter: LaneSpend["meter"], u: RoleUsage): void {
  const lane = lanes.get(meter) ?? { meter, calls: 0, input: 0, cacheRead: 0, output: 0 };
  accumulate(lane, u);
  lanes.set(meter, lane);
}

/** Row order only: biggest spender first. Summing input+output here ORDERS
 *  lanes, it never prints — a cross-lane total is what this reader refuses. */
export const bySpend = (a: LaneSpend, b: LaneSpend) => b.input + b.output - (a.input + a.output);

/** Which lane an unstamped (pre-2026-08-09) record came from, and whether its
 *  `input` is the uncached part. Both are inferable and neither may be assumed:
 *  a single "unstamped" bucket would mix three provider accounts AND two
 *  conventions, committing in one row the exact two errors this reader
 *  advertises refusing.
 *
 *  The convention test is rule 1's: `cacheRead > input` is arithmetically
 *  impossible when input INCLUDES cached, so one such record proves the whole
 *  role's lane disjoint. Measured: 0 of 925 codex-cli records versus 45/53
 *  coordinator and 193/193 auditor. */
function inferLanes(records: readonly Record<string, unknown>[]): Map<string, string> {
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
  const store = new GateStore(campaignDir);
  const lanes = new Map<string, LaneSpend>();
  const roles = new Map<string, RoleSpend>();
  const excluded = new Map<string, number>();
  let nonMonotone = false;
  // A run filter makes `runId` readable; without one the edge added to every
  // record would be write-only, which is the failure mode this whole reader
  // exists to end. Applied BEFORE lane inference, so a report about one run
  // never labels its lanes from a record it does not show.
  const records = (store.all() as unknown as Record<string, unknown>[]).filter(
    (r) => run === undefined || r.runId === run,
  );
  const lanes0 = inferLanes(records);
  const unmetered = new Map<string, number>();
  // A cancelled worker keeps running, so its dispatch can write TWO
  // usage-bearing completions: one at the cancel, one when the work finally
  // settles. Both are snapshots of the same session's CUMULATIVE total, so
  // summing them counts the whole worker twice — and `declare_campaign_state`
  // cancels every live worker, so this fires on essentially every pause.
  // Fixed at the writer, but every journal already on disk carries the
  // duplicate, and the reader is what those campaigns are read with.
  // The LAST one wins: being cumulative, it is the complete total, and the
  // earlier one is a strict prefix of it.
  // `note` as well as `completion`: a dispatch that finishes successfully AFTER
  // being cancelled records its late artifact as a note, and that note carries
  // the settle-time totals the cancel record was written too early to have.
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
    // Pre-2026-08-09 verification completions summed their own stage records,
    // which are also on file. Counting both is the 27% error.
    // Flagged roll-ups (post-7bd75d5 records; the flag exists only on the
    // handful written between it and the roll-up's deletion).
    if (r.usageRollup === true) {
      bump(excluded, "roll-up of records already counted");
      continue;
    }
    // Historical roll-ups carry no flag: every verification completion before
    // 7bd75d5 summed its own four stage records, which are also on file. Every
    // campaign currently on disk is in that era, so without this the reader
    // reproduces the exact 80.4M-token (27%) inflation it exists to prevent.
    // A `completion` whose handle id is a verification id IS that sum — the
    // same identification the 2026-08-09 study made by hand-matching one
    // parent against its children.
    // `runId` marks a record written after the roll-up was deleted, so a
    // verification completion from this era carries no sum and must not be
    // reported as a historical duplicate.
    if (r.runId === undefined && r.kind === "completion" && typeof r.id === "string" && /^v\d/.test(r.id)) {
      bump(excluded, "verification roll-up, unflagged (pre-7bd75d5 record)");
      continue;
    }
    // Records before the coordinator emitted per-wake leaves carry a running
    // session total. Summing snapshots multiplies them; they need max() per
    // (runId, sessionId), which is a different query — say so, don't guess.
    if (r.cumulative !== undefined) {
      bump(excluded, "cumulative snapshot (pre-leaf coordinator record)");
      continue;
    }
    const u = r.usage as RoleUsage | undefined;
    if (!u || typeof u.input !== "number") {
      // Only records that COULD carry usage count as a gap: a promotion or a
      // note never spends tokens. A provider call that reported nothing is the
      // thing a reader must see, because the agy and chatgpt-cli lanes have no
      // usage parser at all and would otherwise render as simply absent.
      // A verification or gate completion is EMPTY BY DESIGN: those handles
      // register no usage() because their spend is leafed by the stage records
      // underneath them. Counting them as gaps reports the leaf-only design
      // itself as a measurement failure, which is how a first run of this
      // reader claimed 122 unmeasured calls on a campaign that had measured
      // every one of them.
      const leafedElsewhere =
        r.kind === "completion" && typeof r.id === "string" && /^[vg]\d/.test(r.id);
      if (SPENDING_KINDS.has(String(r.kind)) && !leafedElsewhere) {
        bump(excluded, "provider call that reported no usage (unmetered lane, or a reject before parse)");
      }
      continue;
    }
    if ((u as { nonMonotone?: boolean }).nonMonotone) nonMonotone = true;

    // An unstamped record's lane is inferred, and labelled as inferred: its
    // `input` may be the nested kind, in which case it is NOT comparable with
    // a disjoint lane's and must not share a row with one.
    const meter = (u.meter ?? lanes0.get(roleOf(r)) ?? "unstamped") as LaneSpend["meter"];
    bumpLane(lanes, meter, u);

    // Not bumpLane: this bucket is keyed by role AND meter, and carries the
    // role on the row.
    const role = roleOf(r);
    const key = `${role} ${meter}`;
    const byRole = roles.get(key) ?? { role, meter, calls: 0, input: 0, cacheRead: 0, output: 0 };
    accumulate(byRole, u);
    roles.set(key, byRole);
  }

  return {
    byLane: [...lanes.values()].sort(bySpend),
    byRole: [...roles.values()].sort(bySpend),
    excluded: [...excluded].map(([reason, records]) => ({ reason, records })),
    unmetered: [...unmetered].map(([lane, calls]) => ({ lane, calls })),
    nonMonotone,
  };
}

/** Human-readable report. Deliberately prints per-lane subtotals and NO grand
 *  total: a single number across lanes would be the cross-meter sum this
 *  reader exists to refuse. */
export function formatSpend(s: CampaignSpend): string {
  const M = (n: number) => `${(n / 1e6).toFixed(2)}M`;
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
    // reasoning was accumulated per role and never rendered, which made the
    // per-role table quietly less informative than the per-lane one it sits
    // under — and reasoning share is the quantity most of the cost questions
    // in docs/measurement-protocol.md turn on.
    out.push(
      `  ${r.role.padEnd(16)}${lane(r.meter)}${String(r.calls).padStart(6)}` +
        `${M(r.input).padStart(10)}${M(r.cacheRead).padStart(11)}${M(r.output).padStart(9)}${opt(r.reasoning).padStart(11)}`,
    );
  }

  // Floors, named rather than left for the reader to infer from an em dash.
  // A row whose lane never reports a field is a LOWER BOUND on that column,
  // and rule 10 forbids presenting a gap as a measurement.
  const noReasoning = s.byLane.filter((l) => l.reasoning === undefined).map((l) => String(l.meter));
  const noCacheWrite = s.byLane.filter((l) => l.cacheWrite === undefined).map((l) => String(l.meter));
  if (noReasoning.length > 0 || noCacheWrite.length > 0) {
    out.push("");
    out.push("floors — these rows are LOWER BOUNDS, not measurements:");
    if (noReasoning.length > 0) {
      out.push(`  reasoning unreported by: ${noReasoning.join(", ")}`);
      out.push("    (the claude-cli result JSON carries no thinking-token field at all)");
    }
    if (noCacheWrite.length > 0) {
      out.push(`  cacheWrite unreported by: ${noCacheWrite.join(", ")}`);
      // The bracket is empirical, from the one lane that DOES report both, and
      // it is an interval rather than an estimate on purpose: a point estimate
      // here would be indistinguishable from a measurement in three months.
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
  // Rule 1's diagnostic, reported rather than only used internally to label
  // unstamped lanes. `cacheRead > input` is arithmetically impossible when
  // input INCLUDES cached, so a role showing it is disjoint-convention — the
  // test that located the 30% overstatement in the 2026-08-09 study, and the
  // one to run first when a lane's numbers look wrong.
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
  return out.join("\n");
}
