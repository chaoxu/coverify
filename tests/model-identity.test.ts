// Reported-model identity (#21 P3): the backend's own statement of what
// answered is journalled beside the requested spec and surfaced as a query —
// never enforced (auto-refusing would invent policy, design rule 3).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { GateStore } = await import("../src/gates.ts");
const { modelSubstitutions } = await import("../src/observe.ts");

function campaign(label: string) {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coverify-modelid-${label}-`);
  fs.mkdirSync(path.join(dir, ".coverify"), { recursive: true });
  fs.writeFileSync(path.join(dir, "STATEMENT.md"), "# statement\n\nProve X.\n");
  process.env.COVERIFY_STATE_DIR = fs.mkdtempSync(`${os.tmpdir()}/coverify-modelid-state-${label}-`);
  return new GateStore(dir);
}

describe("model substitutions", () => {
  test("a genuine substitution is surfaced; canonical spellings are not", () => {
    const store = campaign("sub");
    // The cross-family guarantee quietly became same-family: requested Opus,
    // answered by a Sol-family model.
    store.append({
      kind: "audit",
      revision: "r001/cand.r1.md",
      modelFamily: "claude-cli/opus",
      reportedModel: "claude-cli/gpt-5.6-sol",
      verdict: "PASS",
    });
    // Same model, the CLI's canonical spelling — not a substitution.
    store.append({
      kind: "comparison",
      revision: "r002/cand.r1.md",
      modelFamily: "claude-cli/opus",
      reportedModel: "claude-cli/claude-opus-5",
      verdict: "PASS",
    });
    // No self-report at all (codex-cli emits no model echo): nothing to say.
    store.append({
      kind: "comparison",
      revision: "r003/cand.r1.md",
      modelFamily: "codex-cli/gpt-5.6-sol",
      verdict: "PASS",
    });
    const subs = modelSubstitutions(store);
    expect(subs.map((s) => s.revision)).toEqual(["r001/cand.r1.md"]);
    expect(subs[0].requested).toBe("claude-cli/opus");
    expect(subs[0].actual).toBe("claude-cli/gpt-5.6-sol");
  });

  test("a downgrade within one provider is a substitution", () => {
    const store = campaign("downgrade");
    store.append({
      kind: "audit",
      revision: "r004/cand.r1.md",
      modelFamily: "chatgpt-cli/gpt-5-6-pro",
      reportedModel: "chatgpt-cli/gpt-5-5-mini",
      verdict: "PASS",
    });
    expect(modelSubstitutions(store)).toHaveLength(1);
  });
});
