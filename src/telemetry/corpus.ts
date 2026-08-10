// docs/measurement-protocol.md rule 3b, executable. Run before quoting a number
// off the session trees: three defensible methods on the raw-skill corpus gave
// 150,503M / 15,779M / 5,560M presented input, a 27x spread, and that arm was
// withdrawn. The protocol's checks assume a CUMULATIVE per-event counter (codex
// rollouts); pi logs a per-message DELTA, so a check that cannot apply must
// declare itself inapplicable rather than answer silently (rule 10).
import { median } from "../view/shared.js";
import { campaignTurns } from "../view/turns.js";

export interface CorpusCheck {
  n: number;
  name: string;
  /** false = do not sum this corpus until the relationship is characterized. */
  ok: boolean;
  /** true when the check cannot be evaluated on this corpus shape at all. */
  notApplicable?: boolean;
  detail: string;
}

export function corpusChecks(campaignDir: string): CorpusCheck[] {
  const sessions = campaignTurns(campaignDir);
  const out: CorpusCheck[] = [];

  // 1. Count distinct ids, not files: on the raw corpus 64 ids owned 635 files
  //    replaying a shared prefix, so summing files counted that prefix 64x.
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

  // 2. First cumulative near zero (independent) or high (inherited) — not
  //    reachable on a delta-logged corpus, so this check declares itself
  //    inapplicable and reports the first billed input instead.
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

  // 3. Many events sharing one timestamp is the signature of replay. BILLED
  //    turns only: a parallel tool batch lands three or more toolResults on one
  //    millisecond, which failed this check on every healthy campaign on disk.
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

  // 4. Accumulated total vs the sum of per-turn deltas. Compaction spend belongs
  //    to no turn, so it is added back. Assistant turns only, matching what the
  //    session total bills (see turns.ts's assistant-only filter).
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
