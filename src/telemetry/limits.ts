// The constraint that actually stops campaigns (issue #30): subscription runs
// are not metered in dollars, so what binds is a rolling window. Danus died on
// it, 55% -> 100% of a weekly allowance in 3h52m, which makes --agent-limit a
// burst-rate control and not only a concurrency knob. `codex exec --json` stdout
// carries no rate-limit event (verified against 0.145.0), so #35 records a join
// key and the numbers are read from codex's rollouts under ~/.codex/sessions/.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRecords } from "./shared.js";

export interface LimitSample {
  ts: number;
  usedPercent: number;
  windowMinutes: number;
  resetsAt?: number;
}

export interface LimitsReport {
  /** `exact` = matched a recorded providerSessionId or backendCwd;
   *  `time-window` = matched by coverify's temp-dir signature within the
   *  campaign's span, an INFERENCE, and labelled as one. */
  attribution: "exact" | "time-window" | "none";
  rollouts: number;
  samples: LimitSample[];
  /** Steepest sustained rise, in percentage points per hour, with its span. */
  fastestBurn?: { pointsPerHour: number; from: LimitSample; to: LimitSample };
  /** Credits are overage currency: a nonzero balance means the included
   *  allowance was exhausted and real money started. */
  creditsEverUsed: boolean;
}

const rolloutDirs = (root: string, fromMs: number, toMs: number): string[] => {
  // ~/.codex/sessions/YYYY/MM/DD. Walk only the days the campaign spans; the
  // disk holds ~10k other rollouts.
  const out: string[] = [];
  const day = 86_400_000;
  for (let t = fromMs - day; t <= toMs + day; t += day) {
    const d = new Date(t);
    const p = path.join(
      root,
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    );
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
};

export function campaignLimits(campaignDir: string, run?: string): LimitsReport {
  const { records } = runRecords(campaignDir, run);
  // `ts` is an ISO-8601 STRING on every record, not epoch millis. Number() on it
  // yields NaN, which reports "no rollout attributed" for a full campaign.
  const times = records.map((r) => Date.parse(String(r.ts))).filter((n) => Number.isFinite(n) && n > 0);
  if (times.length === 0) return { attribution: "none", rollouts: 0, samples: [], creditsEverUsed: false };

  // A campaign that made no provider call has no window to report. Its record
  // timestamps collapse to an instant, and the +-1 day widening below then
  // pools in every rollout on the machine from that window — a campaign holding
  // one note reported "peak 95.0% occupancy", which is someone else's number
  // wearing this campaign's name.
  if (!records.some((r) => r.usage !== undefined || typeof r.unmetered === "string")) {
    return { attribution: "none", rollouts: 0, samples: [], creditsEverUsed: false };
  }

  const sessionIds = new Set(
    records.map((r) => r.providerSessionId).filter((v): v is string => typeof v === "string"),
  );
  const cwds = new Set(records.map((r) => r.backendCwd).filter((v): v is string => typeof v === "string"));

  const from = Math.min(...times);
  const to = Math.max(...times);
  const root = path.join(os.homedir(), ".codex", "sessions");
  const samples: LimitSample[] = [];
  let rollouts = 0;
  let creditsEverUsed = false;
  let sawExact = false;
  let sawInferred = false;

  for (const dir of rolloutDirs(root, from, to)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      let meta: { session_id?: string; cwd?: string } | undefined;
      try {
        meta = JSON.parse(lines[0] ?? "{}")?.payload;
      } catch {
        continue;
      }
      const exact =
        (meta?.session_id !== undefined && sessionIds.has(meta.session_id)) ||
        (meta?.cwd !== undefined && cwds.has(meta.cwd));
      // Every CLI role gets its own temp workdir, so the cwd is this harness's
      // signature even before the join key. Reported as inference.
      const inferred = !exact && (meta?.cwd ?? "").includes("coverify-cli-");
      if (!exact && !inferred) continue;

      let used = false;
      for (const line of lines) {
        if (!line.includes("rate_limits")) continue;
        let e: { timestamp?: string; payload?: { rate_limits?: unknown } };
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const rl = e.payload?.rate_limits as
          | { primary?: { used_percent?: number; window_minutes?: number; resets_at?: number }; credits?: { balance?: string } }
          | undefined;
        const p = rl?.primary;
        if (!p || typeof p.used_percent !== "number") continue;
        const ts = Date.parse(e.timestamp ?? "");
        if (!Number.isFinite(ts) || ts < from - 86_400_000 || ts > to + 86_400_000) continue;
        samples.push({
          ts,
          usedPercent: p.used_percent,
          windowMinutes: p.window_minutes ?? 0,
          resetsAt: p.resets_at,
        });
        if (Number(rl?.credits?.balance ?? "0") > 0) creditsEverUsed = true;
        used = true;
      }
      if (!used) continue;
      rollouts++;
      if (exact) sawExact = true;
      else sawInferred = true;
    }
  }

  samples.sort((a, b) => a.ts - b.ts);
  // Steepest rise over at least BURN_SPAN_MS, never between adjacent samples:
  // concurrent rollouts put consecutive samples milliseconds apart, and a
  // 2-point rise over 1ms reads as millions of points/hour. The sustained rate
  // is the one that matters (Danus died at roughly 11.6 points/hour).
  const BURN_SPAN_MS = 30 * 60_000;
  let fastestBurn: LimitsReport["fastestBurn"];
  let lo_i = 0;
  for (let j = 0; j < samples.length; j++) {
    while (lo_i + 1 < j && samples[j].ts - samples[lo_i + 1].ts >= BURN_SPAN_MS) lo_i++;
    const a = samples[lo_i];
    const b = samples[j];
    if (b.ts - a.ts < BURN_SPAN_MS) continue;
    // A fall is a window RESET, not negative spend; skip rather than average.
    if (b.usedPercent <= a.usedPercent) continue;
    const rate = (b.usedPercent - a.usedPercent) / ((b.ts - a.ts) / 3_600_000);
    if (fastestBurn === undefined || rate > fastestBurn.pointsPerHour) {
      fastestBurn = { pointsPerHour: rate, from: a, to: b };
    }
  }

  return {
    attribution: rollouts === 0 ? "none" : sawInferred && !sawExact ? "time-window" : sawExact && sawInferred ? "time-window" : "exact",
    rollouts,
    samples,
    fastestBurn,
    creditsEverUsed,
  };
}

export function formatLimits(r: LimitsReport): string {
  const out: string[] = [];
  out.push("rate-limit occupancy — the constraint that actually ends campaigns.");
  out.push("Subscription runs are not metered in dollars; what binds is a rolling window.");
  out.push("");
  if (r.rollouts === 0) {
    out.push("No codex rollout could be attributed to this campaign.");
    out.push("Nothing is claimed from that: this lane may not have run, or its rollouts");
    out.push("may have been pruned. An absent measurement is not a measurement of zero.");
    return out.join("\n");
  }
  out.push(
    r.attribution === "exact"
      ? `  ${r.rollouts} rollout(s), joined EXACTLY on the recorded providerSessionId/backendCwd.`
      : `  ${r.rollouts} rollout(s), attributed by coverify's temp-dir signature within the`,
  );
  if (r.attribution !== "exact") {
    out.push("  campaign's time span WIDENED BY A DAY EITHER SIDE. That is an INFERENCE,");
    out.push("  not a join: any other campaign run on this machine within that window is");
    out.push("  pooled in. Records written since the");
    out.push("  join key landed (#35) join exactly instead.");
  }
  const w = r.samples[0]?.windowMinutes ?? 0;
  const windows = new Set(r.samples.map((s) => s.windowMinutes));
  out.push(
    `  window: ${w} min (${(w / 1440).toFixed(1)} days)` +
      (windows.size > 1 ? ` — CHANGED mid-campaign, saw ${[...windows].join(", ")}` : ""),
  );
  const hi = Math.max(...r.samples.map((s) => s.usedPercent));
  // NOT called resets: used_percent is account-wide and rollouts run
  // concurrently, so a stale sample explains a fall equally well.
  let falls = 0;
  for (let i = 1; i < r.samples.length; i++) {
    if (r.samples[i].usedPercent < r.samples[i - 1].usedPercent - 1) falls++;
  }
  out.push(
    `  occupancy: first ${r.samples[0].usedPercent.toFixed(1)}%, peak ${hi.toFixed(1)}%, ` +
      `last ${r.samples[r.samples.length - 1].usedPercent.toFixed(1)}% over ${r.samples.length} samples`,
  );
  if (falls > 0) {
    out.push(
      `  ${falls} fall(s) in the series — a window reset OR a stale sample from one of`,
    );
    out.push("  the concurrent rollouts; this reader cannot distinguish them, so the peak");
    out.push("  is the occupancy this campaign is known to have reached, not a total.");
  }
  if (r.fastestBurn) {
    const b = r.fastestBurn;
    const hours = (b.to.ts - b.from.ts) / 3_600_000;
    out.push(
      `  fastest burn: ${b.pointsPerHour.toFixed(1)} points/hour ` +
        `(${b.from.usedPercent.toFixed(1)}% -> ${b.to.usedPercent.toFixed(1)}% in ${hours.toFixed(2)}h)`,
    );
    const headroom = (100 - hi) / b.pointsPerHour;
    out.push(`  at that rate, ${headroom.toFixed(1)}h of headroom remained from the peak.`);
  }
  out.push(
    `  credits: ${r.creditsEverUsed ? "CONSUMED — the included allowance was exhausted" : "none consumed (balance 0 on every sample)"}`,
  );
  out.push("");
  out.push("Occupancy is what bound this run. A dollar figure cannot see it, and a");
  out.push("campaign that fits a month's spend can still die in an afternoon — which");
  out.push("makes --agent-limit a burst-rate control, not only a concurrency knob.");
  return out.join("\n");
}
