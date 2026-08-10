// Keyed lookup over FAILED.md (issue #28). The launcher requires a prior-route
// check before every route; the only affordance was reading a file that grows
// all campaign, and a read is re-presented on every later turn of the dispatch.
//
// The assertions that matter here are about FORMAT TOLERANCE. The issue's
// design assumed entries look like `## F001 - M1 <title>`; measured 2026-08-10,
// that holds in ONE of seven live campaigns. A parser demanding it would
// return nothing on the other six — silently, and in the direction that makes
// a reasoner assert "no close prior route" when there was one.
import { expect, test } from "bun:test";

const { parseFailedEntries, matchFailedEntries } = await import("../src/failed-index.ts");

/** The three heading formats actually on disk, verbatim in shape. */
const REAL = `# FAILED (append-only)

Preamble that belongs to no entry.

## F001 — M1 freeze all LP-local-vertex blocks
**Obstruction:** the freeze does not survive contraction.
**Retry bar:** a named new invariant.

## CE-MAT-FLAG — exact matroid-basis architectures
**Obstruction:** counterexample at rank 4.

## F-H1-NAIVE-RELAY-01 — same-name precedence does not propagate binary orientation
**Obstruction:** the relay loses orientation across a delimiter.
`;

test("entries are parsed from every heading format on disk, not one id scheme", () => {
  const entries = parseFailedEntries(REAL);
  expect(entries).toHaveLength(3);
  expect(entries.map((e) => e.heading)).toEqual([
    "## F001 — M1 freeze all LP-local-vertex blocks",
    "## CE-MAT-FLAG — exact matroid-basis architectures",
    "## F-H1-NAIVE-RELAY-01 — same-name precedence does not propagate binary orientation",
  ]);
  // The banner and preamble belong to no entry and must not be returned as one.
  expect(entries[0].text).not.toContain("Preamble");
  // An entry carries its body, so a match returns the obstruction verbatim.
  expect(entries[0].text).toContain("does not survive contraction");
});

test("a heading term outranks a body term", () => {
  // "closest prior route is X" is usually a heading question: the mechanism
  // label lives there when a campaign uses one.
  const m = matchFailedEntries(parseFailedEntries(REAL), "matroid");
  expect(m[0].heading).toContain("CE-MAT-FLAG");
  expect(m[0].score).toBe(2);
});

test("a body-only term still matches, so an obstruction is findable", () => {
  const m = matchFailedEntries(parseFailedEntries(REAL), "contraction");
  expect(m).toHaveLength(1);
  expect(m[0].heading).toContain("F001");
  expect(m[0].score).toBe(1);
});

test("no match returns nothing rather than everything", () => {
  // A lookup that degrades to the whole file on a miss would reintroduce the
  // cost it exists to remove. The TOOL answers a miss with the heading index,
  // which is a few hundred bytes; the matcher itself returns nothing.
  expect(matchFailedEntries(parseFailedEntries(REAL), "topology homotopy")).toEqual([]);
  expect(matchFailedEntries(parseFailedEntries(REAL), "")).toEqual([]);
});

test("matching is case-insensitive and ignores punctuation", () => {
  // Mechanism labels are written inconsistently across campaigns — `M1`,
  // `CE-MAT-FLAG`, `F-H1-NAIVE-RELAY-01` — so an exact-token matcher would
  // miss on spelling alone.
  const m = matchFailedEntries(parseFailedEntries(REAL), "ce_mat_flag");
  expect(m[0].heading).toContain("CE-MAT-FLAG");
});

test("an empty or entryless ledger parses to nothing, not to one giant entry", () => {
  expect(parseFailedEntries("")).toEqual([]);
  expect(parseFailedEntries("# FAILED (append-only)\n\nNothing closed yet.\n")).toEqual([]);
});

test("every match is returned; the caller decides how many to show", () => {
  // Truncating inside the matcher would recreate, one layer down, the "you
  // cannot see what you did not fetch" problem the whole issue is about.
  const many = `# FAILED (append-only)\n\n${Array.from(
    { length: 30 },
    (_, i) => `## F${String(i).padStart(3, "0")} — M9 shared mechanism\nbody\n`,
  ).join("\n")}`;
  expect(matchFailedEntries(parseFailedEntries(many), "M9")).toHaveLength(30);
});

test("stopwords do not outrank the entry that actually matches", () => {
  // Without stopwords a sentence-shaped query ranks on "the" and "not", and
  // heading noise beats the entry holding the real close route.
  const md = `# FAILED (append-only)

## F001 — the route that does not use any of the words we care about
body text

## F002 — CE-MAT-FLAG
the exact matroid-basis contraction argument fails at rank 4
`;
  const m = matchFailedEntries(parseFailedEntries(md), "I want to try the contraction of the matroid basis for all of them");
  expect(m[0].heading).toContain("CE-MAT-FLAG");
});

test("a `## ` inside a fenced block is a code comment, not an entry", () => {
  // A fence-unaware parse invents a phantom entry and detaches the retry bar
  // from the real one.
  const md = `# FAILED (append-only)

## F001 — real entry
**Obstruction:** the freeze does not survive contraction.

\`\`\`
## this is a code comment, not a heading
\`\`\`

**Retry bar:** a named new invariant.
`;
  const entries = parseFailedEntries(md);
  expect(entries).toHaveLength(1);
  expect(entries[0].text).toContain("Retry bar");
  expect(entries[0].text).toContain("named new invariant");
});

test("CRLF ledgers parse with verbatim headings", () => {
  const entries = parseFailedEntries("# FAILED\r\n\r\n## F001 — alpha\r\nbody\r\n");
  expect(entries[0].heading).toBe("## F001 — alpha");
  expect(entries[0].heading).not.toContain("\r");
});

test("the TOOL bounds its payload and says so — it must cost less than the read it replaces", async () => {
  // The defect this pins: the first version returned every nonzero match,
  // trusting a cap that does not apply to it (capResultText wraps read/ls/grep
  // only). A query naming a revision id matched all 53 entries and returned the
  // whole 86 KB ledger — MORE than the ordinary read tool, which caps at 50 KB
  // and announces its offset. No test instantiated the tool, so nothing caught it.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { workspaceTools } = await import("../src/workspace.ts");

  const dir = fs.mkdtempSync("/private/tmp/coverify-failedtool-");
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n");
  const ledger = path.join(dir, "FAILED.md");
  // 60 entries of ~2 KB each: bigger than the bound, like every live ledger.
  fs.writeFileSync(
    ledger,
    `# FAILED (append-only)\n\n${Array.from(
      { length: 60 },
      (_, i) => `## F${String(i).padStart(3, "0")} — shared mechanism M9\n${"obstruction prose. ".repeat(100)}\n`,
    ).join("\n")}`,
  );

  const tools = workspaceTools(dir, { allow: [dir], deny: [] }, { failedLedger: ledger });
  const tool = tools.find((t) => t.name === "failed_routes");
  expect(tool).toBeDefined();

  const text = (r: Awaited<ReturnType<NonNullable<typeof tool>["execute"]>>) =>
    r.content.map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("");

  // Every entry matches, so this is the worst case the defect exposed.
  const hit = text(await tool!.execute("1", { query: "M9 shared mechanism" }));
  expect(hit).toContain("60 of 60 entries");
  expect(hit.length).toBeLessThan(50_000); // under the read tool's own cap
  // And it must SAY it truncated — a silent cut would let a reasoner assert
  // "no close prior route" against matches it never saw.
  expect(hit).toContain("The rest are NOT below");

  // A miss returns heading + first line for every entry, not headings alone:
  // the obstruction is what decides "close", and it lives in the body.
  const miss = text(await tool!.execute("2", { query: "homotopy sheaf cohomology" }));
  expect(miss).toContain("No entry in FAILED.md matched");
  expect(miss).toContain("obstruction prose");
  expect(miss.length).toBeLessThan(fs.readFileSync(ledger, "utf8").length);
});
