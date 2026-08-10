import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot } from "./campaign.js";

/**
 * The contract lives IN THIS REPO. Coverify is canonical for it: the launcher
 * is the spec this harness executes, so it is versioned beside the code that
 * enforces it, and `git show <commit>:contract/math-proof-search-launcher.md`
 * reproduces exactly the text that governed any run.
 *
 * It used to be read from ~/kb, a personal knowledge base nobody else has,
 * which made the repo unrunnable on a fresh clone AND left a reproducibility
 * hole in the verification records: campaigns stamp `launcherSha256` per run,
 * four distinct values exist across the live campaigns, and no repository at
 * any revision could reconstruct what those hashes meant. The hash recorded
 * THAT the contract changed, never what changed (issue #44).
 *
 * repoRoot() is module-relative, so this resolves to the checkout regardless
 * of cwd or install location.
 */
const DEFAULT_LAUNCHER = () => path.join(repoRoot(), "contract", "math-proof-search-launcher.md");

/**
 * Load the launcher contract and return its single fenced block verbatim.
 * The launcher is the spec: role prompts embed this text, never a paraphrase.
 * Mirrors SKILL.md: if the launcher is unavailable, stop — no silent fallback
 * to a remembered version.
 *
 * COVERIFY_LAUNCHER_PATH still hard-fails when set-but-missing, and that is
 * where "never a remembered version" keeps its teeth: falling back to the
 * bundled copy would hand someone testing an edited contract the shipped one
 * instead, with no signal. Everywhere else the rule is now moot by
 * construction — there is one contract, in the repo, under version control.
 * The guarantee is stronger than it was, not weaker.
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
