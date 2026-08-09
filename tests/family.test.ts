// Ideation families (Chao, 2026-08-09): per-dispatch reasoner routing to a
// second model family; specs env-overridable, unknown families undefined.
import { describe, expect, test } from "bun:test";

const { familyModelSpec, IDEATION_FAMILIES } = await import("../src/providers.ts");

describe("ideation families", () => {
  test("known families resolve to non-default providers; unknown is undefined", () => {
    expect(IDEATION_FAMILIES.sort()).toEqual(["fable", "gemini"]);
    expect(familyModelSpec("fable")?.provider).toBe("anthropic");
    expect(familyModelSpec("gemini")?.provider).toBe("google");
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
