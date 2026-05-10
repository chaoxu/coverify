from __future__ import annotations


COFLAT_PRIMER_VERSION = "coflat-primer-v1"
PROMPT_VERSION = "autoprover-prompts-v1"

COFLAT_PRIMER = """\
# Coflat Format Primer

Return Coflat-compatible Markdown body text unless the prompt explicitly asks for JSON.
Do not include YAML frontmatter; Cosheaf injects id/type/status/target/title.
Start page or proposal bodies with exactly one meaningful H1 heading, e.g. "# Sum of the First Odd Integers". Do not literally write "# Title".

Math:
- Inline math: $x^2$ or \\(x^2\\).
- Display math:
  $$
  \\sum_{i=1}^n i = \\frac{n(n+1)}{2}
  $$
- Labeled equations: put `{#eq:name}` after the display math block.

Theorem-like blocks use Pandoc fenced divs, not code fences:
::: {.theorem #thm:main title="Main theorem"}
Statement with $math$.
:::

::: {.proof}
Proof text.
:::

Common classes: .theorem, .lemma, .proposition, .corollary, .definition, .conjecture, .example, .remark, .proof.
Nested blocks need more colons outside.

References:
- Use [@id] or @id for references.
- Markdown links and [[id]] links are allowed.

Forbidden:
- Do not use triple-backtick code fences for proofs, theorems, definitions, examples, or remarks.
- Do not include frontmatter unless explicitly asked.
- Do not treat unreviewed or rejected context as established truth.
"""
