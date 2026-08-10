// The librarian is a whole external agent spawned inside a reasoner's tool, so
// its tokens belong to no session's own meter and need a leaf of their own.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";

const { JournalTelemetryContext } = await import("../src/telemetry/context.ts");
const { leafDelegatedCall, setTelemetrySink } = await import("../src/providers.ts");
const { workspaceTools } = await import("../src/workspace.ts");
const { GateStore } = await import("../src/gates.ts");

afterEach(() => {
  setTelemetrySink(NOOP_TELEMETRY_CONTEXT);
  for (const e of ["COVERIFY_LITERATURE_CMD", "COVERIFY_STATE_DIR"]) delete process.env[e];
});

function fixture(label: string) {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coverify-${label}-`);
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n\nA fixture.\n");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`${os.tmpdir()}/coverify-${label}-state-`);
  const store = new GateStore(dir);
  const sink = new JournalTelemetryContext(store);
  setTelemetrySink(sink);
  return { dir, store, sink };
}

/** A stub librarian printing a real-shaped agy envelope. */
function stubLibrarian(dir: string, usage?: Record<string, number>): void {
  const stub = path.join(dir, "librarian.sh");
  const body = JSON.stringify({ response: "Three relevant papers.", status: "SUCCESS", usage });
  fs.writeFileSync(stub, `#!/bin/sh\ncat > /dev/null\ncat <<'J'\n${body}\nJ\n`, { mode: 0o755 });
  process.env.COVERIFY_LITERATURE_CMD = stub;
}

const leaves = (store: InstanceType<typeof GateStore>) =>
  store.all().filter((r) => r.kind === "role-call");

test("the librarian leaf inherits the dispatch that ordered it, not the campaign root", async () => {
  // The ordering hazard this pins: a dispatched session is BUILT before its
  // dispatch span exists and receives it later via setTelemetryParent. A
  // callback that captures the parent at build time therefore captures
  // undefined, and every librarian leaf roots at the campaign with no
  // dispatchId and no wake — worse than the unmetered record it replaced,
  // which the harness stamped with the handle id.
  const { store, sink } = fixture("librarian-edges");
  let liveParent: TelemetryContext | undefined; // assigned AFTER the callback is made
  const record = (usage: Parameters<typeof leafDelegatedCall>[2]) =>
    leafDelegatedCall(liveParent, { role: "librarian", modelSpec: "agy/librarian" }, usage);

  await sink.startSpan(
    {
      name: "coverify.dispatch",
      attributes: { "coverify.dispatch_id": "r007", "coverify.wake": 4, "coverify.role": "reasoner" },
    },
    async (dispatchSpan) => {
      liveParent = dispatchSpan;
      record({ input: 5000, output: 40, cacheRead: 900, reasoning: 30, meter: "agy-json" });
    },
  );

  const [leaf] = leaves(store);
  expect(leaf.dispatchId).toBe("r007");
  expect(leaf.wake).toBe(4);
  // Its OWN role, not the reasoner's: the reasoner did not spend these tokens.
  expect(leaf.role).toBe("librarian");
  expect((leaf.usage as { input: number }).input).toBe(5000);
});

test("a metered librarian call writes spend, not a gap", async () => {
  const { dir, store } = fixture("librarian-metered");
  stubLibrarian(dir, { input_tokens: 5000, output_tokens: 40, thinking_tokens: 30, cache_read_tokens: 900 });
  const gaps: string[] = [];
  const tool = workspaceTools(dir, { allow: [dir], deny: [] }, {
    literature: true,
    onUnmetered: (lane) => gaps.push(lane),
    onLibrarianSpend: (usage) => leafDelegatedCall(undefined, { role: "librarian", modelSpec: "s" }, usage),
  }).find((t) => t.name === "literature_search")!;

  const out = await tool.execute("c1", { question: "who proved this?" });
  expect(JSON.stringify(out)).toContain("Three relevant papers");
  // Counted once, as spend. A gap here as well would be the second writer.
  expect(gaps).toEqual([]);
  expect(leaves(store)).toHaveLength(1);
  expect((leaves(store)[0].usage as { meter: string }).meter).toBe("agy-json");
});

test("with telemetry OFF a metered call still records its spend, not silence", async () => {
  // The failure this pins is silent token loss, which is worse than double
  // counting because nothing looks wrong: routing a SUCCESSFUL parse into the
  // span sink alone meant a 22,000-token librarian call left neither spend nor
  // gap on a harness with src/telemetry/ removed. Exactly one writer still
  // fires — the sink when installed, this channel when not.
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coverify-librarian-off-`);
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`${os.tmpdir()}/coverify-librarian-off-state-`);
  setTelemetrySink(NOOP_TELEMETRY_CONTEXT);
  stubLibrarian(dir, { input_tokens: 22711, output_tokens: 63, cache_read_tokens: 0 });

  const channel: { lane: string; detail: string; usage?: unknown }[] = [];
  const tool = workspaceTools(dir, { allow: [dir], deny: [] }, {
    literature: true,
    onUnmetered: (lane, detail) => channel.push({ lane, detail }),
    onLibrarianSpend: (usage) => channel.push({ lane: "librarian", detail: "s", usage }),
  }).find((t) => t.name === "literature_search")!;

  await tool.execute("c1", { question: "who proved this?" });
  expect(channel).toHaveLength(1);
  expect((channel[0].usage as { input: number }).input).toBe(22711);
});

test("an unreadable librarian reply keeps its report and degrades to a gap", async () => {
  // A librarian whose SPEND cannot be read must never become a librarian whose
  // REPORT is lost: COVERIFY_LITERATURE_CMD can point at any command.
  const { dir, store } = fixture("librarian-plain");
  const stub = path.join(dir, "plain.sh");
  fs.writeFileSync(stub, "#!/bin/sh\ncat > /dev/null\necho 'A prose report.'\n", { mode: 0o755 });
  process.env.COVERIFY_LITERATURE_CMD = stub;
  const gaps: string[] = [];
  const tool = workspaceTools(dir, { allow: [dir], deny: [] }, {
    literature: true,
    onUnmetered: (lane) => gaps.push(lane),
    onLibrarianSpend: (usage) => leafDelegatedCall(undefined, { role: "librarian", modelSpec: "s" }, usage),
  }).find((t) => t.name === "literature_search")!;

  const out = await tool.execute("c1", { question: "who proved this?" });
  expect(JSON.stringify(out)).toContain("A prose report.");
  expect(gaps).toEqual(["librarian"]);
  expect(leaves(store)).toHaveLength(0);
});
