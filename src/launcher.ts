import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_LAUNCHER = path.join(
  os.homedir(),
  "kb/notes/agents/prompts/prompt-math-proof-search-launcher.md",
);

/**
 * Load the launcher contract and return its single fenced block verbatim.
 * The launcher is the spec: role prompts embed this text, never a paraphrase.
 * Mirrors SKILL.md: if the launcher is unavailable, stop — no silent fallback
 * to a remembered version.
 */
export function loadLauncherContract(): string {
  const p = process.env.COVERIFY_LAUNCHER_PATH ?? DEFAULT_LAUNCHER;
  if (!fs.existsSync(p)) {
    throw new Error(
      `launcher contract not found at ${p}; set COVERIFY_LAUNCHER_PATH or make ~/kb available. ` +
        "Coverify does not fall back to a remembered version of the contract.",
    );
  }
  const text = fs.readFileSync(p, "utf-8");
  const match = text.match(/^```\n([\s\S]*?)\n```/m);
  if (!match) {
    throw new Error(`launcher at ${p} has no fenced contract block`);
  }
  return match[1];
}
