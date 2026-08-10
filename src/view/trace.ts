/** Renders a campaign's append-only journal as a self-contained HTML timeline.
 *  Observability only: writes nothing back, so it cannot affect campaign
 *  semantics (design rule 2). vis-timeline is inlined at render time so a trace
 *  opens offline and inside a strict CSP — never switch it to a CDN link. */
import * as fs from "node:fs";
import * as path from "node:path";
import { citedEvidencePaths, gateOf, readJournal, readLedger, repoRoot } from "../campaign.js";
import { BODY, STYLES, VIEW } from "./trace-page.js";
import { sameModelId } from "../observe.js";

export interface TraceAgent {
  id: string;
  role: string;
  start: number;
  end?: number;
  cancelled?: boolean;
  /** Infrastructure-failure reason (failed-flagged completion); no report exists. */
  failed?: string;
  mechanism: string;
  /** The packet, as journaled. Fields beyond `task` are undefined on campaigns
   *  whose harness revision did not record them, and the inspector says so
   *  rather than implying emptiness. */
  task: string;
  deliverable?: string;
  context?: string;
  failedCheck?: string;
  computation?: string;
  literature?: string;
  model: string;
  evidenceDir?: string;
  report?: string;
  reportText?: string;
}

export type TraceEvent = Record<string, unknown> & { type: string; t: number };

/** Campaign-shape metrics (issue #15), derived read-only from the journal and
 *  the ledger texts. Danus's directed-cut-union campaign spent 85% of its
 *  verified facts outside the answer's ancestry without being able to see it. */
export interface TraceMetrics {
  /** Worker dispatches whose EVIDENCE/<id>/ artifacts are cited by PROVED.md or
   *  FAILED.md. Mechanical string matching only: an uncited artifact may still
   *  have been useful. */
  citation?: { workers: number; cited: number; orphaned: string[] };
  /** Time with zero live workers inside the worker window (first dispatch →
   *  last completion) — the coordinator-serialization signal behind issue #17's
   *  pipelining decision. */
  idle?: { windowSec: number; idleSec: number; largestGapsSec: number[] };
}

export interface TraceData {
  t0: string;
  span: number;
  agents: TraceAgent[];
  events: TraceEvent[];
  metrics: TraceMetrics;
}

const VENDOR_JS = "vis-timeline/standalone/umd/vis-timeline-graph2d.min.js";
const VENDOR_CSS = "vis-timeline/styles/vis-timeline-graph2d.min.css";

function vendored(rel: string): string {
  // Resolved from the checkout root, so it works from any cwd.
  const p = path.join(repoRoot(), "node_modules", rel);
  if (!fs.existsSync(p)) {
    throw new Error(`missing vendored asset ${rel}; run 'bun install' in the coverify checkout`);
  }
  return fs.readFileSync(p, "utf-8");
}

/** JSON safe to inline in a <script> block. Journal text is model-authored, so
 *  a report quoting HTML would close the tag and the page would render as a
 *  campaign in which nothing happened. U+2028/9 are newlines to a JS parser but
 *  not to JSON. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

/** Cut long text visibly, so a stump is never read as the whole value. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026 [truncated]" : s;
}

/** Journal → plot data. Times are seconds elapsed from the first record. */
export function traceData(dir: string): TraceData {
  const rows = readJournal(dir) as unknown as Record<string, any>[];
  if (rows.length === 0) throw new Error(`no journal entries under ${dir}/.coverify/`);
  // A malformed ts must not become NaN geometry: rows whose timestamp does not
  // parse are skipped, and the span falls back to the last one that did.
  const at = (s: unknown): number | undefined => {
    const ms = Date.parse(String(s));
    return Number.isFinite(ms) ? ms / 1000 : undefined;
  };
  const firstValid = rows.find((r) => at(r.ts) !== undefined);
  if (!firstValid) throw new Error(`no parseable timestamps in ${dir}/.coverify/journal.jsonl`);
  const t0 = firstValid.ts as string;
  const base = at(t0) as number;
  let last = 0;
  const agents = new Map<string, TraceAgent>();
  const events: TraceEvent[] = [];
  const runStarts: number[] = [];
  for (const row of rows) {
    const at_ = at(row.ts);
    if (at_ === undefined) continue;
    const t = at_ - base;
    if (t > last) last = t;
    const g = gateOf(row) as Record<string, any> | undefined;
    if (row.kind === "wake") {
      events.push({ type: "wake", t, n: row.wake, live: row.live ?? 0, reports: row.newReports ?? 0 });
    } else if (row.kind === "note" && (row.runStart === true || row.note === "run-start")) {
      // runStart is the structural marker; the prose match keeps older
      // journals readable.
      runStarts.push(t);
    } else if (g?.kind === "dispatch") {
      agents.set(g.id, {
        id: g.id,
        role: g.role ?? "worker",
        start: t,
        mechanism: clip(String(g.mechanism ?? ""), 200),
        task: clip(String(g.task ?? ""), 400),
        deliverable: g.deliverable,
        context: g.context,
        failedCheck: g.failedCheck,
        computation: g.computation,
        literature: g.literature,
        evidenceDir: g.evidenceDir,
        model: g.modelFamily ?? "",
      });
    } else if (g?.kind === "completion") {
      const a = agents.get(g.id);
      if (a) {
        a.end = Math.max(t, a.start); // never render a negative lifetime
        a.cancelled = Boolean(g.cancelled);
          a.report = g.report;
        if (g.failed !== undefined) a.failed = String(g.failed);
      }
    } else if (
      g?.kind === "audit" ||
      g?.kind === "bundle-cert" ||
      g?.kind === "reconstruction" ||
      g?.kind === "comparison"
    ) {
      events.push({
        type: "verify",
        t,
        stage: g.kind,
        revision: g.revision,
        verdict: g.verdict,
        model: g.modelFamily ?? "",
        // Requested-vs-answered (#21 P3), carried ONLY on a genuine
        // substitution. Use sameModelId, never raw inequality: claude-cli
        // answers `opus` as `claude-opus-5`, which would flag every audit.
        reportedModel:
          typeof g.reportedModel === "string" &&
          typeof g.modelFamily === "string" &&
          !sameModelId(g.reportedModel, g.modelFamily)
            ? g.reportedModel
            : "",
      });
    } else if (g?.kind === "gate-verdict") {
      events.push({ type: "gate", t, verdict: g.verdict, mechanism: String(g.mechanism ?? "").slice(0, 70) });
    } else if (g?.kind === "promotion") {
      events.push({ type: "promotion", t, revision: g.revision });
    } else if (g?.kind === "rebuttal") {
      // Verdict-permission record, rendered beside the verdicts so a
      // FAIL->fresh-attempt->PASS reads as the contract's rebuttal lane. Own
      // event type: folding it into "gate" corrupts the pass-rate tile.
      events.push({ type: "rebuttal", t, revision: g.revision, artifact: g.artifact });
    }
  }
  // Inline each report so the page is inspectable on its own; capped, path kept.
  const CAP = 12_000;
  for (const a of agents.values()) {
    if (!a.report) continue;
    const root = path.resolve(dir);
    const p = path.resolve(root, a.report);
    // The trace must not become a way to read (and publish) a file outside the
    // campaign.
    if (!p.startsWith(root + path.sep) || !fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf-8");
    a.reportText = text.length > CAP ? text.slice(0, CAP) + "\n\n[truncated - open the artifact for the rest]" : text;
  }
  return {
    t0,
    span: Math.max(last, 60),
    agents: [...agents.values()],
    events,
    metrics: computeMetrics(dir, [...agents.values()], Math.max(last, 60), runStarts),
  };
}

/** Worker roles for metrics: dispatched task agents, not judges or cadences. */
const WORKER_ROLES = new Set(["reasoner", "technician", "worker"]);

function computeMetrics(
  dir: string,
  agents: TraceAgent[],
  span: number,
  runStarts: number[],
): TraceMetrics {
  const workers = agents.filter((a) => WORKER_ROLES.has(a.role));
  const metrics: TraceMetrics = {};

  // Ledger-citation coverage, using the same token scan as citation lint.
  // Cancelled and infrastructure-failed dispatches left no citable artifact.
  const cited = new Set<string>();
  for (const f of ["PROVED.md", "FAILED.md"]) {
    if (!fs.existsSync(path.join(dir, f))) continue;
    for (const token of citedEvidencePaths(readLedger(dir, f))) cited.add(token);
  }
  // Zero citations with reported workers renders as 0/N: the 100%-dead-weight
  // case is what this metric exists to expose, never a reason to hide the tile.
  const reported = workers.filter((a) => a.report !== undefined);
  if (reported.length > 0) {
    const isCited = (a: TraceAgent) =>
      [...cited].some((c) => c.startsWith(`EVIDENCE/${a.id}/`)) ||
      (a.report !== undefined && cited.has(a.report));
    metrics.citation = {
      workers: reported.length,
      cited: reported.filter(isCited).length,
      orphaned: reported.filter((a) => !isCited(a)).map((a) => a.id),
    };
  }

  // Worker-idle time: merge the workers' live intervals and subtract from the
  // window they span. An open dispatch died with its run, so it counts as live
  // only until the next run-start; counting it to the end reports a serialized
  // campaign as 0% idle (observed on lin3cut).
  if (workers.length > 0) {
    const openEnd = (start: number): number =>
      runStarts.find((r) => r > start) ?? span;
    const intervals = workers
      .map((a) => ({ start: a.start, end: a.end ?? openEnd(a.start) }))
      .sort((a, b) => a.start - b.start);
    const windowStart = intervals[0].start;
    const windowEnd = Math.max(...intervals.map((i) => i.end));
    let covered = 0;
    const gaps: number[] = [];
    let reach = windowStart;
    for (const i of intervals) {
      if (i.start > reach) gaps.push(i.start - reach);
      covered += Math.max(0, i.end - Math.max(i.start, reach));
      reach = Math.max(reach, i.end);
    }
    metrics.idle = {
      windowSec: windowEnd - windowStart,
      idleSec: Math.max(0, windowEnd - windowStart - covered),
      largestGapsSec: gaps.sort((a, b) => b - a).slice(0, 3),
    };
  }
  return metrics;
}

export function renderTrace(dir: string): string {
  const data = traceData(dir);
  const name = path.basename(path.resolve(dir));
  const started = new Date(Date.parse(data.t0));
  const ended = new Date(Date.parse(data.t0) + data.span * 1000);
  const hours = data.span / 3600;
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
  const title = `${name} — ${
    hours < 1 ? Math.round(hours * 60) + " minutes" : hours.toFixed(1) + " hours"
  }, ${data.agents.length} agents`;
  const body = BODY.replace("__TITLE__", esc(title))
    .replace("__JOURNAL__", esc(path.join(name, ".coverify/journal.jsonl")))
    .replace("__WINDOW__", `${fmt(started)} → ${fmt(ended)} UTC`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${vendored(VENDOR_CSS)}</style>
<style>${STYLES}</style>
</head>
<body>
${body}
<script>${vendored(VENDOR_JS)}</script>
<script>const DATA = ${jsonForScript({ ...data, title, slug: name })};</script>
<script>${VIEW}</script>
</body>
</html>
`;
}

/** `--out` is user-typed: one typo aimed at the journal or a ledger would
 *  destroy the campaign this tool exists to observe. */
function assertSafeOutput(dir: string, target: string): void {
  const root = path.resolve(dir);
  const p = path.resolve(target);
  const inCampaign = p === root || p.startsWith(root + path.sep);
  if (inCampaign && !/\.html$/i.test(p)) {
    throw new Error(`refusing to write a trace over campaign state: ${target}`);
  }
}

export function writeTrace(dir: string, out?: string): string {
  const target = out ?? path.join(dir, ".coverify", "trace.html");
  assertSafeOutput(dir, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderTrace(dir));
  return target;
}
