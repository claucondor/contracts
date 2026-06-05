pragma circom 2.0.0;

// ============================================================================
// WARN: not for production — test zkey only, single-contributor ceremony
// A multi-party trusted-setup ceremony (≥3 contributors) is required before
// mainnet deployment. The test zkey in setup/ is for testnet smoke testing only.
// See: docs/aggregate-handoff.md
// ============================================================================

include "node_modules/circomlib/circuits/babyjub.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

//
// ConfidentialTransferAggregate — 2-generator Pedersen commitment circuit
//
// Replaces the windowed-hash Pedersen from v0.5/v0.6 with the classical
// 2-generator commitment scheme:
//
//   Commit(v, r) := [v]·G + [r]·H
//
// This is properly homomorphic:
//   Commit(v1,r1) + Commit(v2,r2) = Commit(v1+v2, r1+r2)   ✓
//
// The on-chain contract accumulates commitments additively:
//   commit[user] = commit[user] + Commit(amount, blinding_k)
//
// After N deposits the on-chain value is:
//   Σ Commit(v_i, r_i) = Commit(Σv_i, Σr_i)
//
// The prover only needs to know (old_value = Σv_i, old_blinding = Σr_i mod l)
// and the circuit checks that [old_value]·G + [old_blinding]·H == old_commit.
//
// This fixes the "C_old mismatch" bug from v0.5/v0.6 where windowed-hash
// Pedersen was incorrectly used as an additive accumulator.
//
// ─────────────────────────────────────────────────────────────────────────────
// Public input layout (order matters for Solidity verifier ABI call):
//   [0] old_commit[0]      = old commitment x-coordinate
//   [1] old_commit[1]      = old commitment y-coordinate
//   [2] transfer_commit[0] = transfer commitment x-coordinate
//   [3] transfer_commit[1] = transfer commitment y-coordinate
//   [4] new_commit[0]      = new balance commitment x-coordinate
//   [5] new_commit[1]      = new balance commitment y-coordinate
//
// Private inputs:
//   old_value         128-bit token amount (sender's current balance)
//   old_blinding      252-bit blinding scalar (Σ of all received blindings mod l)
//   transfer_value    128-bit amount being transferred
//   transfer_blinding 252-bit fresh blinding for transfer commitment
//   new_blinding      252-bit fresh blinding for new balance commitment
//
// ABI selector: verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])
// ─────────────────────────────────────────────────────────────────────────────
//
// Generator G (= Base8, prime-order subgroup generator of BabyJubJub):
//   G_x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
//   G_y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
//   NOTE: G = Base8 = 8 × (raw BabyJub generator). The raw generator is NOT
//   in the prime-order subgroup (it has full order 8×l). We MUST use Base8 here
//   so that [l]*G = identity, which is required for the homomorphism to hold.
//
// Generator H (NUMS — SHA-256("openjanus:aggregate-pedersen:generator-H:v1") mod l * G):
//   H_x = 20176122646359037043957983780698997220241005801156909477756461731029015465513
//   H_y = 12675495183377259114213499882541802147068931119123218019653136042509354750865
//
// Scalar derivation:
//   seed       = "cadence-crypto-lab:aggregate-pedersen:generator-H:v1"
//   sha256     = dab770fa437522466cc77e342af81afeeea9cf70e63ad98b83463b5819288b13
//   scalar     = 431220823411395456446588864425906976884578672973864058140779376804016099631
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Pedersen2Gen — compute [v]·G + [r]·H
//
// EscalarMulFix(k, BASE) computes [scalar]·BASE where scalar is k bits.
// - Value v: 128 bits (token amount)
// - Blinding r: 252 bits (full subgroup scalar for perfect hiding)
//
// EscalarMulFix internally uses 249-bit segments, so:
//   EscalarMulFix(128, G) handles 128-bit v
//   EscalarMulFix(252, H) handles 252-bit r
// ─────────────────────────────────────────────────────────────────────────────
template Pedersen2Gen() {
    signal input v;          // 128-bit value
    signal input r;          // 252-bit blinding scalar
    signal output out[2];    // commitment point (x, y)

    // Generator G = Base8 (prime-order subgroup generator, [l]*G = identity)
    // Base8 = 8 × raw BabyJub generator — used by all circomlib primitives
    var G[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    // Generator H (NUMS: SHA-256("openjanus:aggregate-pedersen:generator-H:v1") mod l * G, in prime-order subgroup)
    var H[2] = [
        20176122646359037043957983780698997220241005801156909477756461731029015465513,
        12675495183377259114213499882541802147068931119123218019653136042509354750865
    ];

    // ── [v]·G  (128-bit scalar) ──────────────────────────────────────────────
    component vBits = Num2Bits(128);
    vBits.in <== v;

    component vG = EscalarMulFix(128, G);
    var i;
    for (i = 0; i < 128; i++) {
        vG.e[i] <== vBits.out[i];
    }

    // ── [r]·H  (252-bit scalar) ──────────────────────────────────────────────
    component rBits = Num2Bits(252);
    rBits.in <== r;

    component rH = EscalarMulFix(252, H);
    for (i = 0; i < 252; i++) {
        rH.e[i] <== rBits.out[i];
    }

    // ── Commit = [v]·G + [r]·H ──────────────────────────────────────────────
    component addGH = BabyAdd();
    addGH.x1 <== vG.out[0];
    addGH.y1 <== vG.out[1];
    addGH.x2 <== rH.out[0];
    addGH.y2 <== rH.out[1];

    out[0] <== addGH.xout;
    out[1] <== addGH.yout;
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfidentialTransferAggregate — main circuit
// ─────────────────────────────────────────────────────────────────────────────
template ConfidentialTransferAggregate() {
    // ── private inputs ───────────────────────────────────────────────────────
    signal input old_value;           // 128-bit  — sender's accumulated balance
    signal input old_blinding;        // 252-bit  — Σ received blindings mod l
    signal input transfer_value;      // 128-bit  — amount being transferred
    signal input transfer_blinding;   // 252-bit  — fresh blinding for transfer
    signal input new_blinding;        // 252-bit  — fresh blinding for new balance

    // ── public inputs — on-chain commitments verified by Solidity verifier ──
    signal input old_commit[2];          // Commit(old_value, old_blinding)
    signal input transfer_commit[2];     // Commit(transfer_value, transfer_blinding)
    signal input new_commit[2];          // Commit(old_value - transfer_value, new_blinding)

    // ── Step 1: Verify old_commit = Commit(old_value, old_blinding) ──────────
    component P_old = Pedersen2Gen();
    P_old.v <== old_value;
    P_old.r <== old_blinding;
    P_old.out[0] === old_commit[0];
    P_old.out[1] === old_commit[1];

    // ── Step 2: Verify transfer_commit = Commit(transfer_value, transfer_blinding)
    component P_tx = Pedersen2Gen();
    P_tx.v <== transfer_value;
    P_tx.r <== transfer_blinding;
    P_tx.out[0] === transfer_commit[0];
    P_tx.out[1] === transfer_commit[1];

    // ── Step 3: Underflow prevention — transfer_value <= old_value ───────────
    // Both values are 128-bit (enforced by Num2Bits(128) in Pedersen2Gen).
    // LessEqThan(128) prevents double-spend.
    component leq = LessEqThan(128);
    leq.in[0] <== transfer_value;
    leq.in[1] <== old_value;
    leq.out === 1;

    // ── Step 4: Compute new balance and verify new_commit ────────────────────
    signal new_balance;
    new_balance <== old_value - transfer_value;  // non-negative guaranteed by Step 3

    component P_new = Pedersen2Gen();
    P_new.v <== new_balance;
    P_new.r <== new_blinding;
    P_new.out[0] === new_commit[0];
    P_new.out[1] === new_commit[1];
}

component main {public [
    old_commit,
    transfer_commit,
    new_commit
]} = ConfidentialTransferAggregate();
