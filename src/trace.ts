/**
 * Campaign trace: renders a campaign's append-only journal as a self-contained
 * HTML timeline — agent lifetimes, verification cadence, coordinator wakes.
 * Observability only: it reads harness audit metadata and writes nothing back,
 * so it cannot affect campaign semantics (design rule 2). The timeline widget
 * is vis-timeline, inlined at render time so a trace opens offline and inside
 * a strict CSP.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readJournal } from "./campaign.js";
import { BODY, STYLES, VIEW } from "./trace-page.js";

export interface TraceAgent {
  id: string;
  role: string;
  start: number;
  end?: number;
  cancelled?: boolean;
  /** Infrastructure-failure reason (failed-flagged completion); no report exists. */
  failed?: string;
  mechanism: string;
  /** The packet, as journaled. Fields beyond `task` exist only for campaigns
   *  run by a harness revision that recorded them; older runs leave them
   *  undefined and the inspector says so rather than implying emptiness. */
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

export interface TraceData {
  t0: string;
  span: number;
  agents: TraceAgent[];
  events: TraceEvent[];
}

const VENDOR_JS = "vis-timeline/standalone/umd/vis-timeline-graph2d.min.js";
const VENDOR_CSS = "vis-timeline/styles/vis-timeline-graph2d.min.css";

function vendored(rel: string): string {
  // Resolved from this module, so it works from any cwd.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const p = path.join(here, "..", "node_modules", rel);
  if (!fs.existsSync(p)) {
    throw new Error(`missing vendored asset ${rel}; run 'bun install' in the coverify checkout`);
  }
  return fs.readFileSync(p, "utf-8");
}

/**
 * JSON safe to inline in a <script> block. Journal text is model-authored: a
 * report quoting HTML, or a technician pasting a snippet, would otherwise
 * close the tag — and the page then renders as a campaign in which nothing
 * happened, which is worse than an error. U+2028/9 are newlines to a JS
 * parser but not to JSON.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

/** Cut long text at a boundary the reader can see, so a stump is never
 *  mistaken for the whole value. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026 [truncated]" : s;
}

/** Journal → plot data. Times are seconds elapsed from the first record. */
export function traceData(dir: string): TraceData {
  const rows = readJournal(dir) as unknown as Record<string, any>[];
  if (rows.length === 0) throw new Error(`no journal entries under ${dir}/.coverify/`);
  // A malformed ts must not become NaN geometry (or crash the render): rows
  // whose timestamp does not parse are skipped, and the span falls back to the
  // last one that did.
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
  for (const row of rows) {
    const at_ = at(row.ts);
    if (at_ === undefined) continue;
    const t = at_ - base;
    if (t > last) last = t;
    const g = row.gate && typeof row.gate === "object" ? (row.gate as Record<string, any>) : undefined;
    if (row.kind === "wake") {
      events.push({ type: "wake", t, n: row.wake, live: row.live ?? 0, reports: row.newReports ?? 0 });
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
        if (typeof g.failed === "string") a.failed = g.failed;
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
      });
    } else if (g?.kind === "gate-verdict") {
      events.push({ type: "gate", t, verdict: g.verdict, mechanism: String(g.mechanism ?? "").slice(0, 70) });
    } else if (g?.kind === "promotion") {
      events.push({ type: "promotion", t, revision: g.revision });
    }
  }
  // Inline each report so the page is inspectable on its own; capped, with the
  // path kept so the full artifact is one click away in the campaign folder.
  const CAP = 12_000;
  for (const a of agents.values()) {
    if (!a.report) continue;
    const root = path.resolve(dir);
    const p = path.resolve(root, a.report);
    // The harness writes this field itself, but the trace must not become a
    // way to read (and publish) a file outside the campaign.
    if (!p.startsWith(root + path.sep) || !fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf-8");
    a.reportText = text.length > CAP ? text.slice(0, CAP) + "\n\n[truncated - open the artifact for the rest]" : text;
  }
  return { t0, span: Math.max(last, 60), agents: [...agents.values()], events };
}

/** Self-contained HTML: no network, no external assets. */
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

/**
 * Campaign files a trace must never overwrite. `--out` is a user-typed path,
 * and one typo aimed at the journal or a ledger would destroy the campaign
 * this tool exists to observe.
 */
function assertSafeOutput(dir: string, target: string): void {
  const root = path.resolve(dir);
  const p = path.resolve(target);
  const inCampaign = p === root || p.startsWith(root + path.sep);
  if (inCampaign && !/\.html$/i.test(p)) {
    throw new Error(`refusing to write a trace over campaign state: ${target}`);
  }
}

/** Writes the trace HTML and returns the output path. */
export function writeTrace(dir: string, out?: string): string {
  const target = out ?? path.join(dir, ".coverify", "trace.html");
  assertSafeOutput(dir, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderTrace(dir));
  return target;
}
