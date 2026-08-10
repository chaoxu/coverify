// docs/measurement-protocol.md rule 3b, executable. The rule exists because a
// session-log corpus can look summable and not be: three defensible methods on
// the raw-skill corpus gave 150,503M / 15,779M / 5,560M presented input, a 27×
// spread, and the honest outcome was to withdraw the arm rather than pick the
// flattering estimate. Danus passed all four checks (411 files, 411 distinct
// ids, no replay), which is why its estimators agreeing MEANT something.
//
// Run this before quoting a number off the session trees. It converts one
// PROCESS failure class from prose into a check, which is what this repo does
// with rules everywhere else.
//
// Two of the four checks are stated for corpora that log a CUMULATIVE counter
// per event (codex rollouts). pi's session JSONL logs a per-message DELTA, so
// those two are restated for this corpus rather than silently skipped or, worse,
// silently answered — a check that cannot apply must say so (rule 10).
import { campaignTurns } from "./turns.js";

export interface CorpusCheck {
  n: number;
  name: string;
  /** false = the corpus fails this check and must not be summed until the
   *  relationship is characterized. */
  ok: boolean;
  /** true when the check cannot be evaluated on this corpus shape at all. */
  notApplicable?: boolean;
  detail: string;
}

export function corpusChecks(campaignDir: string): CorpusCheck[] {
  const sessions = campaignTurns(campaignDir);
  const out: CorpusCheck[] = [];

  // 1. Count distinct ids, not files. On the raw corpus 64 ids owned 635 files
  //    replaying a shared prefix, and summing files counted that prefix 64×.
  const ids = new Map<string, number>();
  for (const s of sessions) ids.set(s.id, (ids.get(s.id) ?? 0) + 1);
  const multi = [...ids].filter(([, n]) => n > 1);
  out.push({
    n: 1,
    name: "one file per session id",
    ok: multi.length === 0,
    detail:
      multi.length === 0
        ? `${sessions.length} files, ${ids.size} distinct ids`
        : `${sessions.length} files, ${ids.size} distinct ids — ${multi.length} id(s) own more than one file ` +
          `(worst: ${multi.sort((a, b) => b[1] - a[1])[0][1]} files). Characterize the relationship before summing.`,
  });

  // 2. First cumulative near zero (independent) or high (inherited). pi logs a
  //    delta per message, so "inherited" cannot present as a large first value
  //    the way it does in a cumulative log. The reachable question is whether
  //    the first BILLED message looks like a whole inherited context.
  const firstInputs = sessions
    .map((s) => s.turns.find((t) => t.usage !== undefined)?.usage?.input)
    .filter((v): v is number => v !== undefined);
  out.push({
    n: 2,
    name: "first record is independent, not inherited",
    ok: true,
    notApplicable: true,
    detail:
      `not applicable to a delta-logged corpus: pi writes per-message usage, not a running total, ` +
      `so there is no first cumulative to read. Reported instead: median first billed input ` +
      `${firstInputs.length > 0 ? median(firstInputs).toLocaleString() : "n/a"} tokens over ` +
      `${firstInputs.length} session(s).`,
  });

  // 3. Many events sharing one timestamp is the signature of replay — a
  //    transcript re-emitted rather than lived.
  //    Counted over BILLED turns only. A parallel tool batch legitimately
  //    lands three or more toolResults on one millisecond, and counting those
  //    made this check fail on every healthy campaign on disk — a check that
  //    cries wolf is worse than no check, because it trains you to skip it.
  let worstShared = 0;
  let worstFile = "";
  for (const s of sessions) {
    const byTs = new Map<number, number>();
    for (const t of s.turns) {
      if (t.ts === undefined || t.usage === undefined) continue;
      byTs.set(t.ts, (byTs.get(t.ts) ?? 0) + 1);
    }
    for (const [, n] of byTs) {
      if (n > worstShared) {
        worstShared = n;
        worstFile = s.file;
      }
    }
  }
  out.push({
    n: 3,
    name: "no replay signature (events sharing one timestamp)",
    // Two turns can legitimately share a millisecond; a pile cannot.
    ok: worstShared <= 2,
    detail:
      worstShared <= 2
        ? `worst billed-event timestamp collision is ${worstShared} event(s)`
        : `${worstShared} events share one timestamp in ${worstFile} — replay signature; do not sum.`,
  });

  // 4. Reconcile per-session deltas against that session's own total. On a
  //    delta-logged corpus the reachable form is: does the accumulated total
  //    equal the sum of the per-turn deltas? A mismatch means the accumulator
  //    and the turn view disagree, which is the defect this repo's one genuine
  //    cross-check exists to surface.
  //    Compaction spend belongs to no turn, so it is added back explicitly
  //    rather than tolerated as slop: a session that compacted is EXPECTED to
  //    differ by exactly that amount, and a check that cannot tell that apart
  //    from corruption reports every healthy compacted session as a failure.
  //    Assistant turns only, matching what the session total bills. Summing
  //    every turn would make this check FAIL the day a non-assistant message
  //    carries usage — which is precisely the case turns.ts's assistant-only
  //    filter exists for, so the check would fire on the filter working as
  //    designed and report a healthy corpus as unsummable.
  const mismatched = sessions.filter((s) => {
    const summed =
      s.turns.reduce((n, t) => n + (t.role === "assistant" ? (t.usage?.input ?? 0) : 0), 0) +
      (s.compaction?.input ?? 0);
    return summed !== s.usage.input;
  });
  out.push({
    n: 4,
    name: "per-session deltas reconcile against the session total",
    ok: mismatched.length === 0,
    detail:
      mismatched.length === 0
        ? `${sessions.length} session(s) reconcile exactly`
        : `${mismatched.length} session(s) disagree with their own turn deltas (first: ${mismatched[0].file}). ` +
          `Note compaction spend lives on a compaction entry, not on a turn, so a session that compacted ` +
          `is EXPECTED to differ — check that before treating this as corruption.`,
  });

  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function formatCorpusChecks(checks: CorpusCheck[]): string {
  const out: string[] = [];
  out.push("corpus checks (docs/measurement-protocol.md rule 3b) — run these before quoting");
  out.push("a number off the session trees. A corpus that fails one is not summable.");
  for (const c of checks) {
    let mark: string;
    if (c.notApplicable) mark = "n/a ";
    else if (c.ok) mark = "ok  ";
    else mark = "FAIL";
    out.push(`  ${mark} ${c.n}. ${c.name}`);
    out.push(`       ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok && !c.notApplicable);
  out.push("");
  if (failed.length === 0) {
    out.push("No check failed. That is a licence to sum this corpus, not a guarantee the");
    out.push("numbers mean what you want them to (rules 7 and 8).");
  } else {
    out.push(`${failed.length} CHECK(S) FAILED — do not sum this corpus until the relationship is`);
    out.push("characterized.");
  }
  return out.join("\n");
}
