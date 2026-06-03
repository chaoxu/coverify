# Coverify Agent Guidance

## Prefer Agentic Preparation Over More Harness Code

When planning Coverify work, do not respond to uncertainty by adding another
deterministic Python planning layer by default. If the task requires judgment,
context selection, route choice, or deciding what evidence matters, prefer an
agentic preparation step or oracle call that can inspect the allowed material.

The harness should stay small:

- Python tools expose source bundles, Cosheaf operations, backend invocation,
  audit trails, validation, and verification gates.
- Agents and oracles decide which context matters, which route to try, and how
  to frame a mathematical question.
- Local code validates agent output mechanically, for example by checking file
  paths, line ranges, citations, schemas, hashes, and verifier verdicts.
- Add deterministic code only when the behavior is stable, repeatable, and
  genuinely simpler than asking an agent to inspect the allowed context.

For repo-snapshot chat specifically, the preferred flow is:

```text
question + thread + allowed source-bundle root
  -> agentic prepare_context over the bundle files
  -> mechanical range extraction and citation validation
  -> answerer
  -> independent verifier
  -> response/comment
```

Avoid rebuilding a large planner in Python. The right boundary is agentic
preparation with mechanical validation, not ever more pre-gather heuristics.
