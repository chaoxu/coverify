// The trace renderer is observability: it must read the journal faithfully and
// must never write campaign state or depend on the network.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { traceData, renderTrace, writeTrace } = await import("../src/view/trace.ts");

function campaign(rows: object[]) {
  const dir = fs.mkdtempSync("/private/tmp/coverify-trace-");
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".coverify", "journal.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return dir;
}

const T = (min: number) => new Date(Date.UTC(2026, 7, 1, 3, min)).toISOString();
const gate = (ts: string, g: object) => ({ ts, kind: "note", gate: { ts, ...g } });

const dir = campaign([
  { ts: T(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
  gate(T(1), { kind: "dispatch", id: "r001", role: "reasoner", mechanism: "route-A", task: "prove X", modelFamily: "m/x" }),
  gate(T(2), { kind: "dispatch", id: "t002", role: "technician", mechanism: "search", task: "enumerate", modelFamily: "m/x" }),
  gate(T(9), { kind: "completion", id: "r001", report: "EVIDENCE/r001/report.r1.md" }),
  gate(T(11), { kind: "audit", revision: "cand.r1.md", verdict: "FAIL", modelFamily: "m/a" }),
  gate(T(12), { kind: "gate-verdict", mechanism: "route-A", verdict: "IDEA PASS" }),
  gate(T(20), { kind: "promotion", revision: "cand.r2.md" }),
  { ts: T(21), kind: "wake", wake: 2, live: 1, newReports: 1 },
]);

describe("traceData", () => {
  const d = traceData(dir);
  test("pairs dispatches with completions", () => {
    const r = d.agents.find((a) => a.id === "r001")!;
    expect(r.role).toBe("reasoner");
    expect(r.start).toBe(60);
    expect(r.end).toBe(540);
  });
  test("leaves an uncompleted dispatch open", () => {
    expect(d.agents.find((a) => a.id === "t002")!.end).toBeUndefined();
  });
  test("carries verification, gate, promotion and wake events", () => {
    const kinds = d.events.map((e) => e.type);
    expect(kinds.filter((k) => k === "verify").length).toBe(1);
    expect(kinds.filter((k) => k === "gate").length).toBe(1);
    expect(kinds.filter((k) => k === "promotion").length).toBe(1);
    expect(kinds.filter((k) => k === "wake").length).toBe(2);
    expect(d.events.find((e) => e.type === "verify")!.verdict).toBe("FAIL");
  });
  test("span covers the whole journal", () => expect(d.span).toBe(21 * 60));
  test("refuses a campaign with no journal", () => {
    expect(() => traceData(fs.mkdtempSync("/private/tmp/coverify-empty-"))).toThrow(/no journal entries/);
  });
});

describe("renderTrace", () => {
  const html = renderTrace(dir);
  test("is self-contained: no external requests", () => {
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']?https?:/i);
    expect(html).not.toMatch(/@import\s+url\(/i);
  });
  test("inlines the timeline library and the data", () => {
    expect(html).toContain("vis-timeline");
    expect(html).toContain("const DATA =");
    expect(html).toContain("r001");
  });
  test("leaks no escape sequences into visible markup", () => {
    // Only our own markup: the vendored bundle legitimately contains \uXXXX.
    // A formatter that escapes non-ASCII in source would otherwise surface as
    // literal "·" on the page, since String.raw keeps escapes raw.
    const markup = html.slice(html.indexOf("<body>"), html.indexOf("<script>"));
    expect(markup).not.toMatch(/\\u[0-9a-fA-F]{4}/);
    expect(markup).toContain("&middot;");
  });
  test("writes only inside .coverify and leaves the campaign alone", () => {
    const before = fs.readdirSync(dir).sort();
    const out = writeTrace(dir);
    expect(out).toBe(path.join(dir, ".coverify", "trace.html"));
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(dir, ".coverify", "journal.jsonl"), "utf8")).toContain("r001");
  });
});


describe("a trace must not misreport a campaign", () => {
  const T2 = (min: number) => new Date(Date.UTC(2026, 7, 1, 4, min)).toISOString();
  const hostile = campaign([
    { ts: T2(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
    // Model-authored text that closes the data script would blank the page.
    gate(T2(1), { kind: "dispatch", id: "r001", role: "reasoner", mechanism: "m", task: "quote </script><div id=PWNED>x</div> here" }),
    gate(T2(2), { kind: "dispatch", id: "r002", role: "reasoner", mechanism: "m", task: "t" }),
    gate(T2(3), { kind: "dispatch", id: "r003", role: "reasoner", mechanism: "m", task: "t" }),
    gate(T2(4), { kind: "completion", id: "r002", cancelled: true, reason: "campaign pause" }),
    gate(T2(5), { kind: "completion", id: "r003", failed: "spawn ENOENT" }),
    { ts: "not-a-timestamp", kind: "wake", wake: 2, live: 1, newReports: 0 },
  ]);

  test("script-closing text cannot break out of the data block", () => {
    const html = renderTrace(hostile);
    const blob = html.slice(html.indexOf("const DATA ="), html.indexOf("</script>", html.indexOf("const DATA =")));
    expect(blob).not.toContain("</script");
    expect(blob).toContain("\\u003c/script");
    // and it is still valid JSON the page can parse
    const json = blob.slice(blob.indexOf("{"), blob.lastIndexOf("}") + 1);
    expect(JSON.parse(json.replace(/\\u003c/g, "<")).agents.length).toBe(3);
  });

  test("cancelled and failed runs are not reported as completions", () => {
    const d = traceData(hostile);
    expect(d.agents.find((a) => a.id === "r002")!.cancelled).toBe(true);
    expect(d.agents.find((a) => a.id === "r003")!.failed).toBe("spawn ENOENT");
  });

  test("an unparseable timestamp neither crashes nor produces NaN geometry", () => {
    const d = traceData(hostile);
    expect(Number.isFinite(d.span)).toBe(true);
    expect(d.span).toBeGreaterThan(0);
    for (const a of d.agents) {
      expect(Number.isFinite(a.start)).toBe(true);
      if (a.end != null) expect(a.end).toBeGreaterThanOrEqual(a.start);
    }
    expect(() => renderTrace(hostile)).not.toThrow();
  });

  test("refuses to write a trace over campaign state", () => {
    const d = campaign([
      { ts: T2(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
      gate(T2(1), { kind: "dispatch", id: "r001", role: "reasoner", mechanism: "m", task: "t" }),
    ]);
    const journal = path.join(d, ".coverify", "journal.jsonl");
    const before = fs.readFileSync(journal, "utf8");
    expect(() => writeTrace(d, journal)).toThrow(/refusing to write/);
    expect(() => writeTrace(d, path.join(d, "PROVED.md"))).toThrow(/refusing to write/);
    expect(fs.readFileSync(journal, "utf8")).toBe(before);
    // A trace file inside the campaign is still fine.
    expect(writeTrace(d, path.join(d, ".coverify", "trace.html"))).toContain("trace.html");
  });

  test("a report path escaping the campaign is not inlined", () => {
    const outside = fs.mkdtempSync("/private/tmp/coverify-outside-");
    fs.writeFileSync(path.join(outside, "secret.md"), "SECRET-CONTENT");
    // An absolute-escaping relative path: ../../<tmp>/secret.md
    const dir = campaign([
      { ts: T2(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
      gate(T2(1), { kind: "dispatch", id: "r001", role: "reasoner", mechanism: "m", task: "t" }),
      gate(T2(2), { kind: "completion", id: "r001", report: "PLACEHOLDER" }),
    ]);
    const journal = path.join(dir, ".coverify", "journal.jsonl");
    fs.writeFileSync(
      journal,
      fs.readFileSync(journal, "utf8").replace("PLACEHOLDER", path.relative(dir, path.join(outside, "secret.md"))),
    );
    expect(renderTrace(dir)).not.toContain("SECRET-CONTENT");
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe("campaign metrics (issue #15)", () => {
  const T3 = (min: number) => new Date(Date.UTC(2026, 7, 2, 4, min)).toISOString();
  test("citation coverage counts ledger-cited worker artifacts", () => {
    const d = campaign([
      { ts: T3(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
      gate(T3(1), { kind: "dispatch", id: "r001", role: "reasoner", mechanism: "m1", task: "t" }),
      gate(T3(2), { kind: "dispatch", id: "r002", role: "reasoner", mechanism: "m2", task: "t" }),
      gate(T3(5), { kind: "completion", id: "r001", report: "EVIDENCE/r001/report.r1.md" }),
      gate(T3(6), { kind: "completion", id: "r002", report: "EVIDENCE/r002/report.r1.md" }),
      // A verification cadence is a judge, not a worker: never counted.
      gate(T3(7), { kind: "dispatch", id: "v003", role: "verification", mechanism: "verification:x", task: "x" }),
    ]);
    fs.writeFileSync(path.join(d, "FAILED.md"), "## route — REFUTED\n\nEvidence: EVIDENCE/r001/report.r1.md\n");
    const m = traceData(d).metrics;
    expect(m.citation).toEqual({ workers: 2, cited: 1, orphaned: ["r002"] });
  });
  test("idle time is the uncovered part of the worker window", () => {
    const d = campaign([
      { ts: T3(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
      gate(T3(1), { kind: "dispatch", id: "r001", role: "reasoner", mechanism: "m", task: "t" }),
      gate(T3(5), { kind: "completion", id: "r001", report: "EVIDENCE/r001/report.r1.md" }),
      gate(T3(10), { kind: "dispatch", id: "r002", role: "reasoner", mechanism: "m", task: "t" }),
      gate(T3(15), { kind: "completion", id: "r002", report: "EVIDENCE/r002/report.r1.md" }),
    ]);
    const m = traceData(d).metrics;
    // window 60s..900s; live 60-300 and 600-900; idle gap 300-600.
    expect(m.idle).toEqual({ windowSec: 840, idleSec: 300, largestGapsSec: [300] });
  });
});

describe("model substitution flag (#21 P3)", () => {
  // The alias rule must be single-source: claude-cli answers a request for
  // `opus` with its canonical `claude-opus-5`, which is the SAME model. A raw
  // inequality here would flag every audit on the shipped default config and
  // contradict modelSubstitutions(), the authoritative query.
  const aliased = traceData(
    campaign([
      { ts: T(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
      gate(T(1), {
        kind: "audit",
        revision: "cand.r1.md",
        verdict: "PASS",
        modelFamily: "claude-cli/opus",
        reportedModel: "claude-cli/claude-opus-5",
      }),
    ]),
  );
  const swapped = traceData(
    campaign([
      { ts: T(0), kind: "wake", wake: 1, live: 0, newReports: 0 },
      gate(T(1), {
        kind: "audit",
        revision: "cand.r1.md",
        verdict: "PASS",
        modelFamily: "chatgpt-cli/gpt-5-6-pro",
        reportedModel: "chatgpt-cli/gpt-5-5-mini",
      }),
    ]),
  );
  test("a canonical alias is not flagged", () => {
    expect(aliased.events.find((e) => e.type === "verify")!.reportedModel).toBe("");
  });
  test("a genuine substitution is flagged", () => {
    expect(swapped.events.find((e) => e.type === "verify")!.reportedModel).toBe("chatgpt-cli/gpt-5-5-mini");
  });
});
