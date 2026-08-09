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

  test("pi-style path forms cannot bypass the guard: ~, @, file://", async () => {
    const { evidence } = campaign();
    const tools = workspaceTools(evidence, { allow: [evidence], deny: [] });
    const read = tool(tools, "read");
    const grep = tool(tools, "grep");
    // pi's resolveToCwd expands these AFTER a naive guard would have judged
    // them relative — each must be judged as its expanded form and refused.
    expect(text(await grep.execute("b1", { pattern: "x", path: "~" }))).toContain("READ SCOPE REFUSED");
    expect(text(await read.execute("b2", { path: "~/.ssh/known_hosts" }))).toContain("READ SCOPE REFUSED");
    expect(text(await read.execute("b3", { path: "@/etc/hosts" }))).toContain("READ SCOPE REFUSED");
    expect(text(await read.execute("b4", { path: "file:///etc/hosts" }))).toContain("READ SCOPE REFUSED");
  });

  test("in-scope grep/ls cannot leak .coverify transcript lines (results are filtered)", async () => {
    const { dir, evidence } = campaign();
    fs.writeFileSync(path.join(dir, ".coverify", "session-transcript.jsonl"), "SECRETMARKER reasoning\n");
    fs.writeFileSync(path.join(dir, "EVIDENCE", "r001", "legit.md"), "SECRETMARKER in evidence\n");
    const tools = workspaceTools(evidence, { allow: [evidence], deny: [] });
    const grep = tool(tools, "grep");
    // Param is the campaign root — in scope — but ripgrep runs --hidden, so
    // only result filtering keeps the transcript line out.
    const out = text(await grep.execute("h1", { pattern: "SECRETMARKER", path: dir }));
    expect(out).toContain("legit.md");
    expect(out).not.toContain("session-transcript");
    const ls = tool(tools, "ls");
    const listing = text(await ls.execute("h2", { path: dir }));
    expect(listing).not.toContain("session-transcript");
    expect(listing).toContain("withheld: harness state");
    // A file whose CONTENT mentions .coverify/ is legitimate reasoning
    // material — the read tool must return it unfiltered.
    fs.writeFileSync(
      path.join(dir, "EVIDENCE", "r001", "mentions.md"),
      "the journal lives at .coverify/journal.jsonl and that is fine to say\n",
    );
    const read = tool(tools, "read");
    const body = text(await read.execute("h3", { path: path.join(dir, "EVIDENCE", "r001", "mentions.md") }));
    expect(body).toContain(".coverify/journal.jsonl");
    // Same for grep: a MATCH line whose content mentions .coverify/ is kept
    // (the filter judges the structural path prefix, not the content), and
    // a legitimate sibling named .coverify-* is never dropped.
    fs.writeFileSync(path.join(dir, "EVIDENCE", "r001", ".coverify-notes.md"), "SECRETMARKER sibling\n");
    const out2 = text(await grep.execute("h4", { pattern: "SECRETMARKER|journal", path: dir }));
    expect(out2).toContain(".coverify/journal.jsonl and that is fine");
    expect(out2).toContain(".coverify-notes.md");
  });

  test("statement paths with trailing punctuation still grant; bare top-level dirs never do", () => {
    const prior = fs.mkdtempSync("/private/tmp/coverify-readscope-punct-");
    const dir = fs.mkdtempSync("/private/tmp/coverify-readscope-p2-");
    fs.writeFileSync(
      path.join(dir, "STATEMENT.md"),
      `Prove Y. Prior work is recorded at ${prior}. Mentions of /tmp and https://x.test/private in prose.\n`,
    );
    const roots = readRoots(dir);
    expect(roots).toContain(fs.realpathSync(prior));
    expect(roots).not.toContain("/tmp");
    expect(roots).not.toContain("/private");
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
