---
created: 2026-05-08T08:10:22+00:00
id: coin-fixed-direction-chain-attempt
source: coin-transfer-vector-formulation
submitted: 2026-05-08T08:10:22+00:00
title: Fixed-direction chain attempt for the coin FPT problem
type: failed-direction
---

# Fixed-direction chain attempt

Starting from the transfer-vector formulation, each moved coin contributes one of finitely many vectors in `Z^n`:

- `e_i`, for a coin paid from person `i` to the restaurant;
- `e_i - e_k`, for a coin transferred from person `i` to person `k`.

There are only `n + n(n-1)` such directions. Denomination `w_j` scales these vectors by `w_j`, and the divisibility chain means `w_j | w_{j+1}`.

This suggests the following FPT route:

1. Treat each denomination layer as offering bounded numbers of scaled copies of a fixed finite direction set.
2. Process denominations from low to high.
3. Maintain a compressed description of the remaining payment vector in `Z^n`.
4. Use the divisibility chain to pass only a bounded symbolic carry vector to the next denomination.

If the carry description can be bounded by a function of `n` only, then each denomination has only `f(n)` states and transitions. The algorithm would run in `f(n) poly(m)` time, with arithmetic on the input numbers but without dynamic programming over their magnitudes.

Current gap: the state bound is not proved. A naive carry vector can still contain large coordinates depending on bills, coin values, or ratios `w_{j+1}/w_j`. The missing step is a normalization theorem saying that two large residual vectors with the same bounded certificate are equivalent for all future higher denominations.

Possible repair direction:

- Prove an exchange lemma for the finite direction set.
- Show that residual vectors can be reduced modulo a bounded lattice basis depending only on `n`.
- Use the chain condition to make the reduction compatible across denomination layers.
