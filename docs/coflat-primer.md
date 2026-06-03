# Coflat Context Primer

This document is retained as format context, not as an implementation contract.
The old harness injected a short guide into explorer/verifier prompts. The new
tool-harness design has no fixed prompt pipeline yet.

## Doc Map

- [README](../README.md) is the repository entry point.
- [Coverify Design](design.md) defines when this primer is used by context
  builders, backend calls, writer skills, and review workflows.
- [References And Future Notes](references.md) explains the paper-inspired
  review and knowledge-format constraints that motivate stable block ids.

The full format lives in Cosheaf/Coflat `FORMAT.md`. A context-building helper
or workflow skill may include parts of this primer when it asks a model backend
to write or review Coflat Markdown.

This primer is formatting context, not a planning recipe. If a run needs to
decide which Coflat pages or blocks matter, use agentic preparation over the
allowed material and then mechanically validate paths, block ids, citations,
and output shape.

## Coflat Formatting Capsule

Use this short guideline in knowledge-base writer calls, cleanup passes, or
context-building excerpts that ask a backend to write or review Coflat
Markdown. It is not needed for pure mathematical oracle calls.

```text
Write Coflat Markdown, a Pandoc Markdown flavor. The only conventions to note:
- Use `$...$` and `$$...$$` for formulas; code fences are only for literal
  data, code, command output, or certificates.
- Use Pandoc fenced divs for citeable math objects, such as:
  `::: {.definition #def:...}`, `::: {.theorem #thm:...}`,
  `::: {.lemma #lem:...}`, `::: {.example #ex:...}`,
  `::: {.remark #obs:... title="Obstruction"}`, and `::: {.proof}`.
- Give stable ids to citeable definitions, results, examples, and
  obstructions. Proof blocks usually need no id unless the proof itself is
  referenced.
- When writing a whole page, start with one H1 and do not add YAML frontmatter.
```

## Required Output Shape

- Return Coflat-compatible Markdown body text unless the prompt explicitly asks
  for JSON.
- Do not include YAML frontmatter unless the specific tool contract asks for
  it. Cosheaf's typed file route owns stable page frontmatter behavior.
- Start page/replacement bodies with exactly one meaningful H1 heading:
  `# Meaningful Title`.
- Do not literally write `# Title`.

## Math

- Inline math: `$x^2$` or `\(x^2\)`.
- Use math mode for mathematical formulas in accepted documents. Do not put
  ordinary inequalities, definitions, or displayed calculations in backtick code
  merely to preserve spacing.
- Display math:

  ```markdown
  $$
  \sum_{i=1}^n i = \frac{n(n+1)}{2}
  $$
  ```

- Labeled equations use pandoc-crossref syntax:

  ```markdown
  $$
  E = mc^2
  $$ {#eq:einstein}
  ```

- Reserve code fences for literal artifacts: command output, raw data,
  pseudocode, LP/certificate input, or path/profile tables whose exact text is
  itself the object being reviewed.

## Theorem-Like Blocks

Accepted mathematical documents should normally use Pandoc fenced divs for
definitions, theorem-like statements, examples, remarks, obstructions, and
proofs. Use these blocks, not code fences:

```markdown
::: {.definition #def:atomic-affine-routing title="Atomic affine routing game"}
Definition text with $math$.
:::

::: {.theorem #thm:main title="Main theorem"}
Statement with $math$.
:::

::: {.proof}
Proof text.
:::
```

Common classes: `.theorem`, `.lemma`, `.proposition`, `.corollary`,
`.definition`, `.conjecture`, `.example`, `.remark`, `.proof`.

For durable mathematical knowledge, theorem-like and obstruction-like blocks
should have stable ids. PR bodies and review notes should refer to those ids
when discussing dependencies, proof obligations, or failed routes.

If a note contains a result and its argument, prefer this shape:

```markdown
::: {.definition #def:...}
...
:::

::: {.lemma #lem:...}
...
:::

::: {.proof}
...
:::
```

Narrative summaries, status ledgers, and source notes can use ordinary
headings, but any claim that future agents may cite as a mathematical object
should be promoted into a semantic block with an id.

Use the block class to communicate mathematical status where possible:

```markdown
::: {.theorem #thm:compactness-main}
Statement.
:::

::: {.conjecture #conj:boundary-case}
Open statement.
:::

::: {.remark #obs:failed-reduction title="Obstruction"}
The reduction to @thm:compactness-main fails because ...
:::
```

Nested blocks need more colons outside:

```markdown
:::: {.theorem title="Outer"}
Statement.

::: {.proof}
Proof.
:::
::::
```

## References

- Reference document or block ids with `[@id]` or narrative `@id`.
- Markdown links to other pages are allowed.
- Link accepted block ids for mathematical dependencies. Link open issues or
  PRs only as workflow pointers, not as mathematical evidence.
- Do not assume wiki-link syntax unless Cosheaf's current format contract says
  it is indexed.

## Forbidden In Math Documents

- Do not use triple-backtick code fences for proofs, theorems, definitions, or
  remarks.
- Do not use triple-backtick code fences as a substitute for math display mode.
- Do not use raw HTML comments.
- Do not include frontmatter unless explicitly asked.
- Treat branch/PR/review/issue context according to the context builder's
  trust distinctions. Only merged `main` pages are accepted workspace
  knowledge.
