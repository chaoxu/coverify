// Shared test scaffolding. The readers' suites built byte-identical fixtures
// apart from the tmp-dir prefix.
import * as fs from "node:fs";
import * as path from "node:path";
import { GateStore } from "../src/gates.ts";

/** A campaign directory holding exactly these gate records. */
export function recordFixture(label: string, records: Record<string, unknown>[]): string {
  const dir = fs.mkdtempSync(`/private/tmp/coverify-${label}-`);
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# STATEMENT\n\nA fixture.\n");
  const store = new GateStore(dir);
  for (const r of records) store.append(r as { kind: "note" } & Record<string, unknown>);
  return dir;
}

/** A campaign whose session tree contains the given files. */
export function sessionFixture(label: string, files: Record<string, string[]>): string {
  const dir = fs.mkdtempSync(`/private/tmp/coverify-${label}-`);
  const sess = path.join(dir, ".coverify", "sessions", "--camp--");
  fs.mkdirSync(sess, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(sess, name), lines.join("\n") + "\n");
  }
  return dir;
}
