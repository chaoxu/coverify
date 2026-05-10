# Future Reinforcement Learning Harness

Autoprover is a proof-writing harness first. A later version may learn better
proof exploration policies dynamically through reinforcement learning.

This should affect the design now in one way: keep useful traces.

Future runs should be able to reconstruct:

- the user direction
- the Cosheaf context documents shown to the agent
- the prompt sent to the explorer or verifier
- the generated page, proposal, or review
- the verifier decisions
- whether the document eventually became golden or rejected
- repair attempts that followed a rejection

The current JSONL trace contract is documented in
[`docs/trace-schema.md`](trace-schema.md).

These traces can become training data for:

- choosing promising exploration directions
- writing better proof attempts
- deciding when to ask for more context
- repairing rejected proofs
- predicting which proposals are likely to become golden

V0 does not implement reinforcement learning. It should avoid choices that make
those traces impossible to recover later.
