// Reconstruction blindness is platform-enforced, not testimony: the harness
// refuses to dispatch a reconstructor whose rendered prompt contains the
// candidate text (2026-08-02 uniformity review — converts the journal's
// "candidate file withheld by harness (enforced)" into a checked fact).
import { describe, expect, test } from "bun:test";

const { assertCandidateWithheld } = await import("../src/gates.ts");

describe("assertCandidateWithheld", () => {
  const candidate = "THEOREM 1. Every widget is a gadget.\n\nProof. By induction on widgets. QED.";

  test("passes when the prompt omits the candidate", () => {
    const prompt = "# Statement\n\nWidgets exist.\n\n# High-level key ideas\n\nInduct on size.";
    expect(() => assertCandidateWithheld(prompt, candidate)).not.toThrow();
  });

  test("refuses a prompt containing the candidate verbatim", () => {
    const prompt = `# Statement\n\nWidgets exist.\n\n# High-level key ideas\n\n${candidate}`;
    expect(() => assertCandidateWithheld(prompt, candidate)).toThrow(/blindness violation/);
  });

  test("refuses regardless of surrounding whitespace in the candidate file", () => {
    const prompt = `# Key ideas\n\n${candidate}`;
    expect(() => assertCandidateWithheld(prompt, `\n\n${candidate}\n`)).toThrow(/blindness violation/);
  });

  test("refuses a candidate reformatted on its way into the prompt", () => {
    // Re-indented, re-wrapped, CRLF: same text, same leak.
    const reflowed = candidate.replace(/\n\n/g, "\r\n").replace(/\. /g, ".\n    ");
    expect(() => assertCandidateWithheld(`# Key ideas\n\n${reflowed}`, candidate)).toThrow(
      /blindness violation/,
    );
  });

  test("an empty candidate never blocks (degenerate file, other gates catch it)", () => {
    expect(() => assertCandidateWithheld("# Statement\n\nAnything.", "  \n ")).not.toThrow();
  });
});
