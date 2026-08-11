// Fixtures for the verification cadence: a campaign with one candidate and
// every verifier role pointed at a stub CLI. Shared because two suites drive
// the same cadence -- cadence.test.ts for the decisions it writes, and
// telemetry.test.ts for the leaves the extension writes underneath it. The
// telemetry case must NOT live in cadence.test.ts: a core test that imports
// src/telemetry/ breaks the property that the folder is deletable.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

const { requestVerificationTool } = await import("../src/cadence.ts");
const { GateStore } = await import("../src/gates.ts");
const { buildModels } = await import("../src/providers.ts");

export const VERIFIER_ENVS = [
  "COVERIFY_MODEL_AUDITOR",
  "COVERIFY_MODEL_CERTIFIER",
  "COVERIFY_MODEL_RECONSTRUCTOR",
  "COVERIFY_MODEL_COMPARATOR",
];

/** Every env this fixture sets, so a suite can clear them in its own afterEach. */
export const FIXTURE_ENVS = [...VERIFIER_ENVS, "COVERIFY_CODEX_CMD", "COVERIFY_STATE_DIR"];

/** A campaign with one candidate, and every verifier role pointed at a stub
 *  CLI that answers the stages in order. Each stub call reports 10 input / 1
 *  output tokens, so "counted exactly once" is checkable by arithmetic. */
export function campaign(label: string, verdicts: string[]) {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coverify-cadence-${label}-`);
  fs.mkdirSync(path.join(dir, "EVIDENCE"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n\nA fixture target.\n");
  fs.writeFileSync(path.join(dir, "PROVED.md"), "");
  fs.writeFileSync(path.join(dir, "EVIDENCE", "cand.r1.md"), "# candidate\n\nA proof.\n");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`${os.tmpdir()}/coverify-cadstate-${label}-`);

  // Answers come from a sequence file, one per call, because the four stages
  // run through the same backend and must return different verdicts.
  // One FILE per answer, not one line: parseFirstLineVerdict requires the
  // verdict to be the whole first line, so a realistic reply keeps its prose
  // on the lines below and cannot be stored line-indexed.
  const seq = path.join(dir, "seq");
  fs.mkdirSync(seq, { recursive: true });
  verdicts.forEach((v, i) => fs.writeFileSync(path.join(seq, `${i + 1}.txt`), v));
  const counter = path.join(dir, "n.txt");
  const stub = path.join(dir, "stub.sh");
  fs.writeFileSync(
    stub,
    `#!/bin/sh\ncat > /dev/null\nn=$(cat ${counter} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${counter}\n` +
      `echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}'\n` +
      `cat ${seq}/$n.txt > "$1"\n`,
    { mode: 0o755 },
  );
  process.env.COVERIFY_CODEX_CMD = `${stub} {out}`;
  for (const e of VERIFIER_ENVS) process.env[e] = "codex-cli/stub@off";
  return { dir, store: new GateStore(dir), calls: () => Number(fs.readFileSync(counter, "utf8").trim()) };
}

/** Run one cadence to completion and hand back the journal it wrote. The id,
 *  wake and rebuttal are parameters because the carry-forward test runs a
 *  SECOND cadence over the same store: a re-attempt against a standing FAIL
 *  gets a fresh verification id and carries the rebuttal the contract
 *  requires. `hasHandle` is asked about this cadence's own id (cadence.ts
 *  `cancelled`) AND about any other dispatch the concurrency guard finds on
 *  the same bytes — hence `alsoLive`. */
export async function runCadence(
  dir: string,
  store: InstanceType<typeof GateStore>,
  opts: {
    id?: string;
    wake?: number;
    rebuttalArtifact?: string;
    settle?: boolean;
    /** Other cadence ids to report as still running, for the concurrency guard. */
    alsoLive?: string[];
    /** Expect the tool to REFUSE: return its message instead of demanding a handle. */
    expectRefusal?: boolean;
  } = {},
) {
  const { id = "v1", wake = 1, rebuttalArtifact, settle = true, alsoLive = [], expectRefusal } = opts;
  const models = await buildModels();
  let promise: (() => Promise<string>) | undefined;
  const tool = requestVerificationTool({
    dir,
    store,
    contract: "CONTRACT",
    models,
    evidenceRelative: (p: string) => (p.includes("..") ? undefined : p),
    declaration: () => undefined,
    mintVerificationId: () => id,
    wake: () => wake,
    hasHandle: (asked: string) => asked === id || alsoLive.includes(asked),
    liveCount: () => 0,
    registerHandle: (h) => {
      promise = h.promise;
    },
  });
  const result = await tool.execute(`call-${id}`, {
    revision: "cand.r1.md",
    declaredDependencies: "none",
    keyIdeas: "the idea, stated at a high level",
    allowedSources: "standard references",
    ...(rebuttalArtifact === undefined ? {} : { rebuttalArtifact }),
  });
  if (expectRefusal === true) {
    if (promise) throw new Error("expected a refusal, but the cadence was dispatched");
    return JSON.stringify(result);
  }
  if (!promise) throw new Error("cadence registered no handle");
  const text = await promise();
  // The harness writes a completion the moment ANY handle settles (harness.ts
  // `persist`), cadences included, and `priorReusableRecord` keys carry-forward
  // on the ABSENCE of one. A fixture that never wrote it left every cadence
  // permanently "stranded", so the reuse test asserted a path production never
  // takes and could not have noticed the requireStranded gate being deleted.
  // `settle: false` is the real stranded case: a crash or transport drop that
  // killed the run before the completion landed.
  if (settle) {
    // Production-faithful: same path shape, a file that EXISTS, and the hash —
    // a fixture record that no reader would accept is not a settled cadence.
    const report = path.join(dir, "EVIDENCE", id, "report");
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, text);
    store.append({
      kind: "completion",
      id,
      report: path.relative(dir, report),
      reportSha256: createHash("sha256").update(text).digest("hex"),
    });
  }
  return text;
}

export const stages = (store: InstanceType<typeof GateStore>) =>
  store.all().filter((r) => ["audit", "bundle-cert", "reconstruction", "comparison"].includes(String(r.kind)));
