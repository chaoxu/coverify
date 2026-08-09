// Read-scope confinement (issue #22): roles read only campaign reasoning
// material — the campaign tree minus .coverify/, plus statement-declared
// prior-route paths. Results are capped at the 50k read budget.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const { workspaceTools, readRoots } = await import("../src/supervise.ts");

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

function campaign() {
  const prior = fs.mkdtempSync("/private/tmp/coverify-readscope-prior-");
  fs.writeFileSync(path.join(prior, "FAILED.md"), "# FAILED\n\nroute X closed.\n");
  const dir = fs.mkdtempSync("/private/tmp/coverify-readscope-");
  fs.writeFileSync(
    path.join(dir, "STATEMENT.md"),
    `Prove X.\n\nPrior routes. The campaign at ${prior} binds as prior-route records.\n`,
  );
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".coverify", "journal.jsonl"), '{"kind":"note"}\n');
  const evidence = path.join(dir, "EVIDENCE", "r001");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "notes.md"), "evidence body\n");
  return { dir, prior, evidence };
}

function tool(tools: { name: string }[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no ${name} tool`);
  return t as { execute: (id: string, params: unknown) => Promise<{ content: { type: string; text?: string }[] }> };
}

describe("read scope", () => {
  test("roots are campaign + statement-declared prior routes", () => {
    const { dir, prior, evidence } = campaign();
    const roots = readRoots(evidence);
    expect(roots).toContain(fs.realpathSync(dir));
    expect(roots).toContain(fs.realpathSync(prior));
  });

  test("reads inside the campaign and prior routes pass; outside and .coverify refuse", async () => {
    const { dir, prior, evidence } = campaign();
    const tools = workspaceTools(evidence, { allow: [evidence], deny: [] });
    const read = tool(tools, "read");
    expect(text(await read.execute("t1", { path: path.join(dir, "STATEMENT.md") }))).toContain("Prove X");
    expect(text(await read.execute("t2", { path: path.join(prior, "FAILED.md") }))).toContain("route X");
    const outside = fs.mkdtempSync("/private/tmp/coverify-readscope-outside-");
    fs.writeFileSync(path.join(outside, "secret.md"), "not yours\n");
    expect(text(await read.execute("t3", { path: path.join(outside, "secret.md") }))).toContain(
      "READ SCOPE REFUSED",
    );
    expect(text(await read.execute("t4", { path: path.join(dir, ".coverify", "journal.jsonl") }))).toContain(
      "harness state",
    );
  });

  test("grep outside scope refuses; oversized results are capped", async () => {
    const { dir, evidence } = campaign();
    const tools = workspaceTools(evidence, { allow: [evidence], deny: [] });
    const grep = tool(tools, "grep");
    expect(text(await grep.execute("g1", { pattern: "x", path: "/Users" }))).toContain("READ SCOPE REFUSED");
    fs.writeFileSync(path.join(dir, "EVIDENCE", "r001", "big.md"), `hit ${"y".repeat(200)}\n`.repeat(600));
    const capped = text(await grep.execute("g2", { pattern: "hit", path: dir }));
    expect(capped.length).toBeLessThan(60_000);
  });
});
