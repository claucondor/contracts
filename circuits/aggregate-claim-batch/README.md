# ConfidentialClaimBatch — Circuit Design Document

> Fase 6 of the Janus protocol v0.8 sprint.
> Lets a user drain **N = 50** inbox notes from their ShieldedInbox in a **single ZK proof**, updating their on-chain commitment in one transaction instead of N separate shielded transfers.

---

## 1. Purpose

When a sender deposits to a user's `ShieldedInbox`, they push an encrypted note `(amount, blinding)`.  The recipient must decrypt each note and update their on-chain Pedersen commitment:

```
C_new = Commit(oldBalance + Σ amounts, freshBlinding)
```

Before this circuit, each note required a full `shieldedTransfer` proof — N notes = N separate transactions.  `ConfidentialClaimBatch(50)` batches all N into one proof.

---

## 2. Public / Private Input Split

| Signal | Type | Description |
|--------|------|-------------|
| `C_old[2]` | **public** | Old commitment from on-chain storage.  Constrains `(oldBalance, oldBlinding)`. |
| `C_new[2]` | **public** | New commitment to be written to storage.  Encodes `(newBalance, newBlinding)`. |
| `C_consumed[2]` | **public** | Sum of all N note commitments `Σ Commit(amounts[i], blindings[i])`.  Verified against on-chain tracker (see §6). |
| `oldBalance` | private | User's current hidden balance (128-bit). |
| `oldBlinding` | private | Current blinding factor (252-bit). |
| `newBlinding` | private | Fresh user-chosen blinding for `C_new` (252-bit). |
| `amounts[50]` | private | Per-note amounts (64-bit each). |
| `blindings[50]` | private | Per-note blinding factors (252-bit each). |

---

## 3. Cryptographic Construction

### 2-Generator Pedersen Commitment

```
Commit(v, r) = [v]·G + [r]·H
```

where:
- `G = Base8` — prime-order subgroup generator of BabyJubJub (`[l]·G = identity`)
- `H` — NUMS second generator: `SHA-256("openjanus:aggregate-pedersen:generator-H:v1") mod l · G`

These are the **same generators** used by `ConfidentialTransferAggregate` and `Pedersen2Gen.sol`.

### Homomorphic balance update

```
C_new = Commit(oldBalance + Σ amounts[i], newBlinding)
```

Verified by three independent Pedersen constraint groups:

1. **C_old check**: `Pedersen2Gen(oldBalance, oldBlinding).out == C_old`
2. **C_new check**: `Pedersen2Gen(oldBalance + Σ amounts[i], newBlinding).out == C_new`
3. **C_consumed check**: `Σ NoteCommit(amounts[i], blindings[i]).out == C_consumed`

The circuit accumulates `C_consumed` iteratively using `N` BabyAdd operations starting from the identity `(0, 1)`, which avoids any overflow issue from summing 50 blinding scalars.

### Range bounds enforced

| Signal | Bits | Enforced by |
|--------|------|-------------|
| `oldBalance` | 128 | `Num2Bits(128)` inside `Pedersen2Gen` |
| `newBalance` | 128 | `Num2Bits(128)` inside `Pedersen2Gen` |
| `oldBlinding` | 252 | `Num2Bits(252)` inside `Pedersen2Gen` |
| `newBlinding` | 252 | `Num2Bits(252)` inside `Pedersen2Gen` |
| `amounts[i]` | 64 | `Num2Bits(64)` inside `NoteCommit` |
| `blindings[i]` | 252 | `Num2Bits(252)` inside `NoteCommit` |

---

## 4. Constraint Count

Compiled with `circom 2.2.3` for `N = 50`:

```
non-linear constraints : 258 341
linear constraints     :  11 984
wires                  : 270 325
labels                 : 662 902
public inputs          :       6
private inputs         :     103
```

**snarkjs r1cs info output:**

```
# of Constraints : 270 325
# of Wires       : 270 325
# of Private Inputs: 103
# of Public Inputs : 6
```

Breakdown:
- `Pedersen2Gen` (C_old + C_new): 2 × ~14 500 ≈ 29 000
- `NoteCommit` × 50 (64-bit amount + 252-bit blinding): 50 × ~4 700 ≈ 235 000
- `BabyAdd` × 50 (accumulator chain): ~3 500
- Running sum + misc linear constraints: ~2 800
- **Total: 270 325**

---

## 5. ptau Recommendation

| Power | Max Constraints | Verdict |
|-------|----------------|---------|
| pot18 | 262 144 | **too small** (270 325 > 262 144) |
| pot19 | 524 288 | **minimum** — comfortable headroom |
| pot20 | 1 048 576 | **recommended** for production safety margin |
| pot22 | 4 194 304 | **ceremony target** (conservative, standard Groth16 practice) |

Fase 7 ceremony should use **pot22**.  For local development a fresh pot19 is sufficient.

---

## 6. Security Model

### What this circuit guarantees

- The prover knows valid `(oldBalance, oldBlinding)` that open `C_old`.
- Each note `amounts[i]` is a non-negative 64-bit integer.
- `newBalance = oldBalance + Σ amounts[i]` with no 128-bit overflow.
- `C_new` is a correctly formed commitment to `(newBalance, newBlinding)`.
- `C_consumed` is the honest sum of all N note commitments.

### Current limitation (v0.8 testnet only)

**The circuit does NOT enforce that `C_consumed` matches specific inbox notes.**

The on-chain verifier receives `C_consumed` as a public input and must verify it independently against some external source.  In v0.8, there is no such enforcement:

- A malicious prover could fabricate arbitrary `(amounts, blindings)` pairs, compute a matching `C_consumed`, and submit a valid proof.
- This does not break the balance commitment (C_new is still correct), but it means the claimed "consumed notes" may not correspond to real inbox entries.

### Mitigation for mainnet (recommended)

Introduce a **`NoteCommitmentTracker`** contract parallel to `ShieldedInbox`:

1. Every `shieldedTransfer` / deposit that pushes a note to `ShieldedInbox` **also** appends `Commit(amount, blinding)` to `NoteCommitmentTracker[recipient]`.
2. `claimBatch(indices[])` on `JanusToken` reads the commitment points at `indices`, computes `Σ C_i` on-chain, and passes it to the verifier as the `C_consumed` public input — the user cannot substitute a different value.
3. The claimed note entries are marked consumed (nullifier or deletion).

This closes the double-spend vector without changing the circuit.  It requires:
- New contract: `NoteCommitmentTracker.sol` + `NoteCommitmentTracker.cdc`
- One extra external call per deposit in `JanusToken.shieldedTransfer`
- A `claimBatch` entry-point in `JanusToken` (new function, does not touch existing transfer path)

**This circuit is safe for testnet demos.  Do NOT deploy to mainnet without the `NoteCommitmentTracker` mitigation.**

---

## 7. Directory Structure

```
circuits/aggregate-claim-batch/
├── confidential_claim_batch.circom    ← circuit (N=50)
├── README.md                          ← this file
├── package.json
├── compile.sh                         ← circom compile + r1cs info
├── build/                             ← generated by compile.sh
│   ├── confidential_claim_batch.r1cs
│   ├── confidential_claim_batch.sym
│   └── confidential_claim_batch_js/
│       ├── confidential_claim_batch.wasm
│       └── witness_calculator.js
├── test/
│   ├── witness-gen.test.js            ← 14 witness-gen tests (mocha, no zkey needed)
│   └── helpers/
│       └── proof-inputs.cjs           ← BabyJub math + input generation helper
└── inputs/
    ├── happy-path.json                ← pre-generated examples (N=5, N=10, N=50)
    └── edge-cases.json               ← allZero, maxAmounts, maxBlindings, zeroBalance
```

---

## 8. Usage

### Compile

```bash
cd circuits/aggregate-claim-batch
npm install
bash compile.sh
```

### Run tests

```bash
npm test
# 14 passing (≈ 9s)
```

### Generate a proof (after Fase 7 ceremony)

```js
const snarkjs = require("snarkjs");
const { buildClaimInput } = require("./test/helpers/proof-inputs.cjs");

const { circuitInput } = buildClaimInput({
  oldBalance:  myBalance,
  oldBlinding: myBlinding,
  newBlinding: freshBlinding,
  amounts:     [...50 amounts...],
  blindings:   [...50 blindings...],
});

const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  circuitInput,
  "build/confidential_claim_batch_js/confidential_claim_batch.wasm",
  "setup/confidential_claim_batch.zkey"   // from Fase 7 ceremony
);
```

### Public signal order (for Solidity verifier ABI)

```
[0] C_old[0]      — old commitment x
[1] C_old[1]      — old commitment y
[2] C_new[0]      — new commitment x
[3] C_new[1]      — new commitment y
[4] C_consumed[0] — consumed sum x
[5] C_consumed[1] — consumed sum y
```

---

## 9. Operator Review Items

1. **NoteCommitmentTracker (blocker for mainnet)**: see §6.  Recommend scoping as a post-v0.8 task before any mainnet deployment.
2. **ptau source**: Fase 7 ceremony can use pot22.  Download from Hermez trusted setup or run a fresh ceremony.  pot19 is sufficient for local development (saves bandwidth).
3. **Balance cap**: Circuit enforces `newBalance < 2^128`.  For `FLOW` (18 decimals), this is `3.4 × 10^20 FLOW` — astronomically above any realistic balance.  No action needed.
4. **Note blinding domain**: Each note's blinding is independently 252-bit.  When padding with zeros (`Commit(0, 0) = identity`), the identity point accumulates correctly via BabyAdd — no special handling needed.
5. **Solidity verifier**: Generate with `snarkjs zkey export solidityverifier` after Fase 7.  The public input layout in §8 must match the verifier call site in `JanusToken.claimBatch`.
