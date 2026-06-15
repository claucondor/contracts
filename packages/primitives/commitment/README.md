# @claucondor/commitment

2-generator Pedersen commitment on BabyJubJub for additive privacy accumulators on Flow.

This package implements the classical Pedersen commitment scheme used by Zcash Sapling, Bulletproofs, and RAILGUN for shielded token balances. The key property is additive homomorphism: commitments to individual amounts can be summed on-chain without revealing any plaintext values, and the prover can reconstruct the accumulated commitment from running sums of the original inputs.

## Math

The commitment scheme is:

```
Commit(v, r) := [v]·G + [r]·H
```

where:
- `G` = BabyJubJub prime-order subgroup generator (Base8, circomlib-compatible)
- `H` = NUMS second generator (see [Generator H derivation](#generator-h-derivation))
- `v` = value to commit (token amount, fits in 128 bits)
- `r` = blinding factor (random scalar in [1, l), 252 bits for perfect hiding)
- `l` = prime-order subgroup order

The scheme is:
- **Computationally binding** — finding `(v', r') ≠ (v, r)` with the same commitment requires solving the elliptic curve discrete log problem.
- **Perfectly hiding** — every curve point is equally likely as a commitment for any value, with a uniformly random blinding factor.
- **Additively homomorphic**:

```
Commit(v1, r1) + Commit(v2, r2)
  = [v1]·G + [r1]·H + [v2]·G + [r2]·H
  = [v1+v2]·G + [r1+r2]·H
  = Commit(v1+v2, r1+r2)     ✓  (mod l)
```

After N incoming commitments, the on-chain accumulator equals `Commit(Σv_i mod l, Σr_i mod l)`. The prover satisfies the corresponding circuit by tracking running sums `(Σv_i, Σr_i mod l)`.

## Generator H derivation

H is derived so that nobody — including the authors — knows the discrete log of H with respect to G. The derivation procedure:

```
H_SEED_HASH = dab770fa437522466cc77e342af81afeeea9cf70e63ad98b83463b5819288b13
              (a 32-byte SHA-256 hash used as the NUMS seed)

scalar      = BigEndian(H_SEED_HASH bytes) mod l
            = 431220823411395456446588864425906976884578672973864058140779376804016099631

H           = scalar · G
H_x         = 20176122646359037043957983780698997220241005801156909477756461731029015465513
H_y         = 12675495183377259114213499882541802147068931119123218019653136042509354750865
```

To independently verify: decode `H_SEED_HASH` from hex to 32 bytes, interpret as a big-endian integer, reduce mod `l`, then compute `scalar · G` on BabyJubJub. The `deriveH()` export performs this re-derivation and asserts the result matches the hardcoded constants.

This is the standard "hash-to-scalar" NUMS ("nothing up my sleeve") approach used by Zcash (§5.4.9.7) and Bulletproofs (§4.1). Recovering `scalar` from the hash bytes requires inverting SHA-256 (preimage resistance), so neither the scalar nor the discrete log `log_G(H)` is computationally accessible.

## Install

```bash
npm install @claucondor/commitment
```

No runtime dependencies. Pure BigInt arithmetic, works in Node ≥ 18.

## TypeScript API

```typescript
import {
  commit,
  addCommits,
  subCommits,
  negateCommit,
  isIdentity,
  pointsEqual,
  verifyHomomorphism,
  SUBORDER,
} from "@claucondor/commitment";
import type { Point } from "@claucondor/commitment";

// Commit to a value with a random blinding factor
const C1: Point = commit(1000n, 42n);
const C2: Point = commit(500n,  99n);

// Homomorphic addition — no plaintext needed
const sum = addCommits(C1, C2);

// Verify: sum == Commit(1500, 141)
const direct = commit(1500n, 141n);
console.log(pointsEqual(sum, direct)); // true

// Accumulate N commitments
const events = [
  { v: 400n, r: 11111n },
  { v: 500n, r: 22222n },
  { v: 100n, r: 33333n },
];
const accumulated = events.reduce(
  (acc, { v, r }) => addCommits(acc, commit(v, r)),
  commit(0n, 0n), // identity
);
// accumulated == commit(1000n, (11111n + 22222n + 33333n) % SUBORDER)

// Self-test the homomorphism (throws on failure)
verifyHomomorphism(); // returns true
```

### Full API surface

| Export | Type | Description |
|--------|------|-------------|
| `commit(v, r)` | `(bigint, bigint) → Point` | Compute `[v]·G + [r]·H` |
| `addCommits(p1, p2)` | `(Point, Point) → Point` | Homomorphic addition |
| `subCommits(p1, p2)` | `(Point, Point) → Point` | Homomorphic subtraction |
| `negateCommit(p)` | `(Point) → Point` | Negate a commitment point |
| `isIdentity(p)` | `(Point) → boolean` | Check if point is identity `(0, 1)` |
| `pointsEqual(p1, p2)` | `(Point, Point) → boolean` | Structural equality |
| `isOnCurve(x, y)` | `(bigint, bigint) → boolean` | Curve membership check |
| `verifyHomomorphism()` | `() → boolean` | Self-test, throws on failure |
| `deriveH()` | `() → { hx, hy, scalar }` | Re-derive H from seed hash |
| `GX, GY` | `bigint` | Generator G coordinates |
| `HX, HY` | `bigint` | Generator H coordinates |
| `H_SEED_HASH` | `string` | SHA-256 hash used for H derivation |
| `H_SCALAR` | `bigint` | Scalar used for H derivation |
| `SUBORDER` | `bigint` | Prime-order subgroup order l |
| `P` | `bigint` | BN254 base field prime |
| `IDENTITY` | `[bigint, bigint]` | Identity element `(0n, 1n)` |
| `pointAdd` | function | Low-level twisted Edwards point addition |
| `pointMul` | function | Low-level scalar multiplication |

## On-chain reference implementations

This package includes two on-chain reference implementations that share the same generator constants:

### Solidity — `contracts/Pedersen2Gen.sol`

Stateless EVM contract. The `addCommits(x1, y1, x2, y2)` function is the low-gas path (~34k gas) for on-chain accumulator updates. The `commit(v, r)` function is provided for testing only (expensive: requires full scalar multiplication on-chain).

```solidity
// Low-gas accumulation (~34k gas)
(uint256 rx, uint256 ry) = pedersen.addCommits(c1x, c1y, c2x, c2y);

// Testing / cross-verification only (expensive)
(uint256 cx, uint256 cy) = pedersen.commit(v, r);
```

### Cadence — `cadence/Pedersen2GenBabyJub.cdc`

Flow Cadence contract that delegates point arithmetic to `BabyJub.sol` on Flow EVM via the cross-VM call pattern. Requires a deployed `BabyJub.sol` address at initialization.

```cadence
import Pedersen2GenBabyJub from 0x<address>

let newCommit = Pedersen2GenBabyJub.addCommits(
    c1: oldCommit,
    c2: transferCommit,
    coa: coa
)
```

The corresponding Groth16 circuit (`ConfidentialTransferAggregate`) that uses this commitment scheme lives in the `@claucondor/groth16` package.

## Testing

```bash
npm test
```

Tests cover:
- Homomorphism for 6 standard vectors (small values, zero left, zero right, token amounts, 18-decimal amounts, blinding overflow)
- Curve membership of all computed points
- Generator distinctness (H ≠ G, H ≠ identity, H ≠ −G)
- Prime-order subgroup membership ([l]·G = [l]·H = identity)
- NUMS derivation reproducibility
- Identity element arithmetic
- Regression lock on all published constants

## Security

EXPERIMENTAL — not audited. Do not use with real funds.

A Groth16 trusted setup ceremony is required before deploying the corresponding circuit to mainnet.

## License

MIT
