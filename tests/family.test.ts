// Ideation families (Chao, 2026-08-09): per-dispatch reasoner routing to a
// second model family; specs env-overridable, unknown families undefined.
import { describe, expect, test } from "bun:test";

const { familyModelSpec, IDEATION_FAMILIES } = await import("../src/providers.ts");

describe("ideation families", () => {
  test("known families resolve to non-default providers; unknown is undefined", () => {
    expect(IDEATION_FAMILIES.sort()).toEqual(["fable", "gemini", "pro"]);
    expect(familyModelSpec("fable")?.provider).toBe("claude-cli");
    expect(familyModelSpec("fable")?.modelId).toBe("opus");
    expect(familyModelSpec("gemini")?.provider).toBe("agy");
    expect(familyModelSpec("gemini")?.modelId).toBe("gemini-3.1-pro-high");
    expect(familyModelSpec("pro")?.provider).toBe("chatgpt-cli");
    expect(familyModelSpec("pro")?.modelId).toBe("gpt-5-6-pro");
    expect(familyModelSpec("sol")).toBeUndefined();
  });

  test("COVERIFY_FAMILY_* overrides the spec", () => {
    process.env.COVERIFY_FAMILY_FABLE = "anthropic/claude-opus-5@low";
    try {
      const s = familyModelSpec("fable");
      expect(s?.modelId).toBe("claude-opus-5");
      expect(s?.thinking).toBe("low");
    } finally {
      delete process.env.COVERIFY_FAMILY_FABLE;
    }
  });
});
