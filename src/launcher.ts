import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot } from "./campaign.js";

/**
 * The contract is versioned in this repo so `launcherSha256` on a verification
 * record is reconstructible from any revision (issue #44). Do not move it back
 * to ~/kb. repoRoot() is module-relative: independent of cwd and install path.
 */
const DEFAULT_LAUNCHER = () => path.join(repoRoot(), "contract", "math-proof-search-launcher.md");

/**
 * Load the launcher contract and return its single fenced block verbatim.
 * Role prompts embed this text, never a paraphrase; if it is unavailable,
 * stop — never fall back to a remembered version. A set-but-missing
 * COVERIFY_LAUNCHER_PATH must hard-fail too: falling back to the bundled copy
 * would silently run the shipped text while you believed you edited it.
 */
export function loadLauncherContract(): string {
  const p = process.env.COVERIFY_LAUNCHER_PATH ?? DEFAULT_LAUNCHER();
  if (!fs.existsSync(p)) {
    throw new Error(
      process.env.COVERIFY_LAUNCHER_PATH !== undefined
        ? `COVERIFY_LAUNCHER_PATH points at ${p}, which does not exist. Coverify does not fall ` +
          "back to the bundled contract when an explicit path is set: that would silently run " +
          "the shipped text while you believed you were testing an edited one."
        : `launcher contract not found at ${p}. It ships in this repository at ` +
          "contract/math-proof-search-launcher.md — a clean checkout has it. Coverify does not " +
          "fall back to a remembered version of the contract.",
    );
  }
  const text = fs.readFileSync(p, "utf-8");
  const match = text.match(/^```\n([\s\S]*?)\n```/m);
  if (!match) {
    throw new Error(`launcher at ${p} has no fenced contract block`);
  }
  return match[1];
}
