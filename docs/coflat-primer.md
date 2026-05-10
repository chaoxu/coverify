# Coflat Prompt Primer

Autoprover injects this short format guide into agent prompts.

The full format lives in Cosheaf/Coflat `FORMAT.md`; this primer is the
operational subset that explorer and verifier agents need on every run.

## Required Output Shape

- Return Coflat-compatible Markdown body text unless the prompt explicitly asks
  for JSON.
- Do not include YAML frontmatter. Cosheaf injects `id`, `type`, `status`,
  `target`, and `title`.
- Start page/proposal bodies with exactly one meaningful H1 heading:
  `# Meaningful Title`.
- Do not literally write `# Title`.

## Math

- Inline math: `$x^2$` or `\(x^2\)`.
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

## Theorem-Like Blocks

Use Pandoc fenced divs, not code fences:

```markdown
::: {.theorem #thm:main title="Main theorem"}
Statement with $math$.
:::

::: {.proof}
Proof text.
:::
```

Common classes: `.theorem`, `.lemma`, `.proposition`, `.corollary`,
`.definition`, `.conjecture`, `.example`, `.remark`, `.proof`.

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
- `[[id]]` links are accepted by Cosheaf's backlink index.

## Forbidden In Math Documents

- Do not use triple-backtick code fences for proofs, theorems, definitions, or
  remarks.
- Do not use raw HTML comments.
- Do not include frontmatter unless explicitly asked.
- Do not treat unreviewed or rejected context as established truth.
