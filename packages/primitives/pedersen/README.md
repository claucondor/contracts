# @claucondor/pedersen

> **Note:** This package implements the circomlib windowed Pedersen hash — a
> collision-resistant hash function that returns a curve point. It is **not**
> the classical 2-generator commitment scheme and is **not** additively
> homomorphic. For additive accumulation use cases (shielded balances where
> on-chain commitments are summed across multiple events), use
> [`@claucondor/commitment`](../commitment/) instead, which implements
> `Commit(v, r) = [v]·G + [r]·H` with the required homomorphism property.

Pedersen commitments on BabyJubJub via Flow cross-VM.

Provides homomorphic point operations for always-private confidential balance updates, combining a Cadence contract (`PedersenBabyJub.cdc`) with a TypeScript SDK.

## Deployed contracts

| Contract | Chain | Address |
|----------|-------|---------|
| `PedersenBabyJub.cdc` | Flow Cadence testnet | `0x7599043aea001283` |
| `BabyJub.sol` (dependency) | Flow EVM testnet | `0x27139AFda7425f51F68D32e0A38b7D43BcB0f870` |

## What is BabyJubJub Pedersen?

A Pedersen commitment to value `v` with blinding `r` is the curve point `C = v*G + r*H`.
The homomorphic property means: `Commit(a) + Commit(b) = Commit(a+b)` — you can add
commitments without revealing values.

BabyJubJub Pedersen is different from BN254 Pedersen because:

| Property | BabyJubJub Pedersen | BN254 Pedersen |
|----------|---------------------|----------------|
| ZK circuit cost | ~3,300 constraints/commitment | ~2,000,000 constraints |
| On-chain Cadence add | ~16 CU (cross-VM dispatch) | ~47,800 CU (not viable) |
| Pattern | Always-private | Commit-and-reveal |

**Use this package** when commitments are operated on homomorphically and never opened.

## Architecture

Commitments are always computed **off-chain** using `circomlibjs`. The Cadence contract
provides only point operations, dispatching expensive field arithmetic to BabyJub.sol via
Flow's cross-VM pattern.

```
Off-chain (TypeScript)           Flow Cadence                Flow EVM
──────────────────────           ─────────────               ─────────────────
computeCommitment(v, r)  →  PedersenBabyJub.addCommits()  → BabyJub.babyAdd()
                                 negate()  — pure Cadence    modexp precompile
```

## Installation

```bash
npm install @claucondor/pedersen @claucondor/babyjub circomlibjs
```

## TypeScript SDK

### Compute a commitment (off-chain)

```typescript
import { computeCommitment } from "@claucondor/pedersen";

const commitment = await computeCommitment(
  1000n,  // value (up to 2^64 - 1)
  42n     // blinding (up to 2^128 - 1, random in production)
);
// commitment = { x: BigInt, y: BigInt } — a BabyJubJub point
```

### Homomorphic operations (off-chain via circomlibjs)

```typescript
import {
  computeCommitment,
  addCommitmentsLocal,
  subCommitmentsLocal,
  identityCommitment,
} from "@claucondor/pedersen";

const cA = await computeCommitment(1000n, 42n);
const cB = await computeCommitment(250n, 99n);

// Homomorphic add: commit(1000) + commit(250) = commit(1250)
const sum = await addCommitmentsLocal(cA, cB);

// Subtraction: commit(1000) - commit(250) = commit(750)
const diff = await subCommitmentsLocal(cA, cB);

// Identity: neutral element for addition
const id = identityCommitment(); // { x: 0n, y: 1n }
```

### Cadence scripts (query live contract)

```typescript
import { SCRIPT_IDENTITY, SCRIPT_NEGATE } from "@claucondor/pedersen";
import * as fcl from "@onflow/fcl";

fcl.config({ "accessNode.api": "https://rest-testnet.onflow.org" });

// Get identity element from deployed contract
const identity = await fcl.query({ cadence: SCRIPT_IDENTITY });

// Negate a commitment
const negated = await fcl.query({
  cadence: SCRIPT_NEGATE,
  args: (arg, t) => [arg(x.toString(), t.UInt256), arg(y.toString(), t.UInt256)],
});
```

## Cadence integration

```cadence
import "EVM"
import PedersenBabyJub from 0x7599043aea001283

transaction(
    senderOldCommit: {String: UInt256},
    transferCommit: {String: UInt256},
    receiverOldCommit: {String: UInt256}
) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("No COA")

        // Homomorphic balance updates — no plaintext values revealed
        let newSenderCommit = PedersenBabyJub.subCommits(
            c1: senderOldCommit, c2: transferCommit, coa: coa
        )
        let newReceiverCommit = PedersenBabyJub.addCommits(
            c1: receiverOldCommit, c2: transferCommit, coa: coa
        )
    }
}
```

## CU and gas measurements (Flow testnet, empirical)

| Operation | Cadence CU | EVM Gas |
|-----------|------------|---------|
| `addCommits` | ~16 CU | ~34,511 gas |
| `subCommits` | ~21 CU | ~34,511 gas |
| `negate` | ~5 CU | 0 (pure Cadence) |
| `identity` | ~2 CU | 0 |

Cadence tx limit: 9,999 CU. Both operations are well within the limit.

## Testing

```bash
# Unit tests (local, no network)
npm test

# Integration tests against live testnet
RUN_INTEGRATION=1 npm test
```

## Security

EXPERIMENTAL — not audited. Do not use with real funds.

## License

MIT
