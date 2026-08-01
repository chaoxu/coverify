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
  mechanism: string;
  task: string;
  model: string;
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

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

/** Journal → plot data. Times are seconds elapsed from the first record. */
export function traceData(dir: string): TraceData {
  const rows = readJournal(dir) as unknown as Record<string, any>[];
  if (rows.length === 0) throw new Error(`no journal entries under ${dir}/.coverify/`);
  const at = (s: string) => Date.parse(s) / 1000;
  const t0 = rows[0].ts as string;
  const base = at(t0);
  const agents = new Map<string, TraceAgent>();
  const events: TraceEvent[] = [];
  for (const row of rows) {
    const t = at(row.ts as string) - base;
    const g = row.gate && typeof row.gate === "object" ? (row.gate as Record<string, any>) : undefined;
    if (row.kind === "wake") {
      events.push({ type: "wake", t, n: row.wake, live: row.live ?? 0, reports: row.newReports ?? 0 });
    } else if (g?.kind === "dispatch") {
      agents.set(g.id, {
        id: g.id,
        role: g.role ?? "worker",
        start: t,
        mechanism: String(g.mechanism ?? "").slice(0, 90),
        task: String(g.task ?? "").slice(0, 170),
        model: g.modelFamily ?? "",
      });
    } else if (g?.kind === "completion") {
      const a = agents.get(g.id);
      if (a) {
        a.end = t;
        a.cancelled = Boolean(g.cancelled);
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
  const last = at(rows[rows.length - 1].ts as string) - base;
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
<script>const DATA = ${JSON.stringify(data)};</script>
<script>${VIEW}</script>
</body>
</html>
`;
}

/** Writes the trace and returns the output path. */
export function writeTrace(dir: string, out?: string): string {
  const target = out ?? path.join(dir, ".coverify", "trace.html");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderTrace(dir));
  return target;
}
