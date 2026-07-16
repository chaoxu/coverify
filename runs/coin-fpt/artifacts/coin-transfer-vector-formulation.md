---
created: 2026-05-08T08:10:22+00:00
id: coin-transfer-vector-formulation
submitted: 2026-05-08T08:10:22+00:00
title: Transfer-vector formulation for the coin FPT problem
type: formulation
---

# Transfer-vector formulation

We can rewrite any two-round protocol as a set of directed coin transfers.

For each denomination `j`, introduce nonnegative integer variables:

- `r_{i,j}`: coins of denomination `w_j` moved from person `i` to the restaurant.
- `t_{i,k,j}`: coins of denomination `w_j` moved from person `i` to person `k`, where `i != k`.

The constraints are:

```text
r_{i,j} + sum_{k != i} t_{i,k,j} <= a_{i,j}
```

for every person `i` and denomination `j`, since person `i` can only place coins they own.

The net payment constraint for person `i` is:

```text
sum_j w_j ( r_{i,j}
          + sum_{k != i} t_{i,k,j}
          - sum_{k != i} t_{k,i,j} ) = p_i.
```

The cost is:

```text
sum_{i,j} r_{i,j} + 2 sum_{i != k, j} t_{i,k,j}.
```

The factor `2` appears because a coin transferred from person `i` to person `k` is placed once and removed once. A coin paid to the restaurant is placed once and not removed by a person.

This is equivalent to the table protocol:

1. Given a protocol, every placed coin is either left on the table for the restaurant or removed by some person. This gives the variables above.
2. Given the variables above, each person places exactly their outgoing coins, each person removes exactly their incoming transfer coins, and the restaurant keeps the `r` coins.

Thus the original problem is a minimum-cost integer flow problem with `n(n-1)+n` transfer directions at every denomination. The only dependence on `m` is the number of denomination layers.
