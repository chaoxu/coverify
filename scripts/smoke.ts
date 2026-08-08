#!/usr/bin/env bun
// Smoke-run reset + launch. A script instead of a bash one-liner because the
// reset deletes: the bash form (`rm -rf .../$(cat campaign-id 2>/dev/null)`)
// once resolved to the parent state directory when the id file was absent
// (2026-08-08 near-miss; fleet docs/bun.md, ad-hoc shell discipline). Every
// path component is validated before rm, and the relaunch is an argv array —
// no shell, no expansion. Loud failure over silent widening.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoRoot } from "../src/campaign.js";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const dir = flag("dir");
if (!dir) {
  console.error(
    "usage: bun scripts/smoke.ts --dir <campaign-dir> [--max-wakes N] [--statement '...']",
  );
  process.exit(2);
}
const maxWakes = flag("max-wakes") ?? "4";
const statement = flag("statement") ?? "Prove that the product of any two odd integers is odd.";

const abs = path.resolve(dir);
if (abs === "/" || abs === os.homedir()) {
  throw new Error(`refusing to reset ${abs}`);
}

// Remove the campaign's state-dir entry first, keyed by its recorded id.
// The id is the opaque 16-hex name GateStore mints (gates.ts); anything else
// means a corrupt or foreign file, and deleting by it would be a guess.
const stateRoot = process.env.COVERIFY_STATE_DIR ?? path.join(os.homedir(), ".local/state/coverify");
const idFile = path.join(abs, ".coverify", "campaign-id");
if (fs.existsSync(idFile)) {
  const id = fs.readFileSync(idFile, "utf-8").trim();
  if (!/^[0-9a-f]{16}$/.test(id)) {
    throw new Error(`campaign-id ${JSON.stringify(id)} is not 16 hex chars; refusing to delete state`);
  }
  fs.rmSync(path.join(stateRoot, id), { recursive: true, force: true });
}
fs.rmSync(abs, { recursive: true, force: true });

const run = spawnSync(
  "bun",
  ["run", path.join(repoRoot(), "src", "cli.ts"), "prove", statement, "--dir", abs, "--max-wakes", maxWakes],
  { stdio: "inherit" },
);
process.exit(run.status ?? 1);
