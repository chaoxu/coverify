# Mathematical Resolution Prompt

The durable operational entry point is
[`coverify-proof-attempt`](../../skills/coverify-proof-attempt/SKILL.md).

Use that skill to prepare one clean mathematical-resolution target from
accepted context and relevant tried routes. The target should request one
resolution artifact from the canonical vocabulary in
`src/coverify/math_contract.py`.

The prompt should include exact statement, hypotheses, accepted context, forced
facts/theorems/methods/route constraints, and "do not retry" notes. If the
resolver ignores a forced constraint or solves a nearby problem, verification
should fail it.

Preparation should let an agent or oracle inspect the allowed context. Add code
only for mechanical validation or named finite computations.

This file is a compatibility shim for older docs and PRs.
