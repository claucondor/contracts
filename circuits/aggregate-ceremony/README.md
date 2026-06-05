# ConfidentialTransferAggregate Circuit

## Overview

This directory contains the Groth16 trusted-setup artifacts for the
`ConfidentialTransferAggregate` circuit — the 2-generator Pedersen commitment
scheme that enables correct homomorphic accumulation in the Janus confidential
token contracts.

### Commitment scheme

```
Commit(v, r) := [v]·G + [r]·H
```

where G and H are independent generators on the BabyJubJub prime-order subgroup
(G = Base8, H = NUMS derivation). This scheme is homomorphic:

```
Commit(v1, r1) + Commit(v2, r2) = Commit(v1+v2, r1+r2)
```

After N wraps or receives the on-chain accumulator is `Commit(Σv_i, Σr_i)`.
The prover only needs to know the scalar pair `(Σv_i, Σr_i mod l)` to construct
a valid witness — no matter how many prior deposits have accumulated.

## Circuit statistics

| Field        | Value  |
|--------------|--------|
| Constraints  | 18,620 |
| Private inputs | 5    |
| Public inputs  | 6    |
| Curve        | BN254  |
| Protocol     | Groth16 |

## Public input layout

Order matters — matches the Solidity verifier ABI (`uint256[6] _pubSignals`):

| Index | Name             | Description                        |
|-------|------------------|------------------------------------|
| 0     | old_commit[0]    | Old commitment x-coordinate        |
| 1     | old_commit[1]    | Old commitment y-coordinate        |
| 2     | transfer_commit[0] | Transfer commitment x-coordinate |
| 3     | transfer_commit[1] | Transfer commitment y-coordinate |
| 4     | new_commit[0]    | New balance commitment x-coordinate|
| 5     | new_commit[1]    | New balance commitment y-coordinate|

## Private inputs

| Name              | Bits | Description                             |
|-------------------|------|-----------------------------------------|
| old_value         | 128  | Sender's accumulated balance            |
| old_blinding      | 252  | Sum of all received blindings mod l     |
| transfer_value    | 128  | Amount being transferred                |
| transfer_blinding | 252  | Fresh blinding for transfer commitment  |
| new_blinding      | 252  | Fresh blinding for new balance commit   |

## Generators

### G — Base8 (prime-order subgroup generator of BabyJubJub)

```
G_x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
G_y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
```

G = 8 × (raw BabyJub generator). MUST be Base8 so that [l]·G = identity.

### H — NUMS second generator

```
H_x = 20176122646359037043957983780698997220241005801156909477756461731029015465513
H_y = 12675495183377259114213499882541802147068931119123218019653136042509354750865
```

Derivation: H = (sha256("openjanus:aggregate-pedersen:generator-H:v1") mod l) · G

## Directory layout

```
circuits/aggregate-ceremony/
  confidential_transfer_aggregate.circom   — circuit source
  package.json                             — circomlib peer dep
  node_modules/circomlib/                  — circom standard library
  build/
    confidential_transfer_aggregate.r1cs   — R1CS constraint system
    confidential_transfer_aggregate.sym    — symbol map
    confidential_transfer_aggregate_js/
      confidential_transfer_aggregate.wasm — WebAssembly witness generator
      generate_witness.js
      witness_calculator.js
  setup/
    confidential_transfer_aggregate_test.zkey  — TESTNET-ONLY test zkey
    verification_key.json
```

## Ceremony status

**Current: TESTNET-ONLY — single-contributor test zkey**

The `confidential_transfer_aggregate_test.zkey` was generated with a single
contributor and is suitable only for testnet smoke testing. It MUST NOT be
used for mainnet deployment.

**Required before mainnet:**
- Multi-party Phase 2 ceremony with at least 3 independent contributors
- Each contributor adds entropy: `snarkjs zkey contribute`
- Final beacon randomness applied: `snarkjs zkey beacon`
- Phase 2 verification: `snarkjs zkey verify`
- New Solidity verifier exported from production zkey

The `pot18_hez.ptau` (Hermez Powers of Tau, 2^18 constraints) is the shared
Phase 1 SRS used by all circuits in this project. It is not committed to the
repository (large binary). Set `PTAU_PATH` environment variable or place it at
`circuits/aggregate-ceremony/setup/pot18_hez.ptau` to regenerate.

## Solidity verifier

Generated from the test zkey:

```
packages/janus-token/contracts/solidity/ConfidentialTransferAggregateVerifier.sol
```

WARN header: single-contributor test zkey — regenerate from production zkey before mainnet.
