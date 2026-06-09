pragma circom 2.0.0;

include "node_modules/circomlib/circuits/pedersen.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/babyjub.circom";

//
// ConfidentialTransfer v0.5 — Production Circuit
//
// v0.5 changes vs v0.3:
//   - All value range checks bumped from Num2Bits(64) → Num2Bits(128)
//   - LessEqThan(64) → LessEqThan(128) for underflow prevention
//   - Pedersen input width bumped from 192 → 256 bits per commitment
//   - Maximum transferable value 2^128 wei ≈ 3.4×10^38 (effectively unbounded)
//   - Public input shape UNCHANGED — same 6-element pubSignals layout
//
// Proves simultaneously:
//   1. old_commit   == Pedersen(old_value   || old_blinding)      [sender consistency]
//   2. transfer_commit == Pedersen(transfer_value || transfer_blinding) [transfer consistency]
//   3. new_commit   == Pedersen(old_value - transfer_value || new_blinding) [new balance]
//   4. transfer_value in [0, 2^128)  (Num2Bits(128) enforces this — was 64)
//   5. transfer_value <= old_value   (LessEqThan(128) underflow prevention — was 64)
//
// Production parameters (v0.5):
//   - value:   128-bit (was 64-bit; effectively unbounded for practical amounts)
//   - blinding: 128-bit (unchanged — beyond brute-force standard)
//
// Pedersen input width: 128 (value) + 128 (blinding) = 256 bits per commitment (was 192)
//
// Commitments are BabyJubJub curve points (x, y) lying on the Baby-Jubjub
// curve embedded in the BN254 scalar field.
//
// Public input layout (order matters for Solidity verifier call — UNCHANGED from v0.3):
//   [0] old_commit[0]      = old commitment x-coordinate
//   [1] old_commit[1]      = old commitment y-coordinate
//   [2] transfer_commit[0] = transfer commitment x-coordinate
//   [3] transfer_commit[1] = transfer commitment y-coordinate
//   [4] new_commit[0]      = new balance commitment x-coordinate
//   [5] new_commit[1]      = new balance commitment y-coordinate
//
// ABI selector: verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6]) — UNCHANGED
//
template ConfidentialTransfer() {
    // -----------------------------------------------------------------------
    // Private inputs
    // -----------------------------------------------------------------------
    signal input old_value;          // 128-bit — sender's current balance (was 64-bit)
    signal input old_blinding;       // 128-bit — blinding factor for old_commit
    signal input transfer_value;     // 128-bit — amount being transferred (was 64-bit)
    signal input transfer_blinding;  // 128-bit — blinding factor for transfer_commit
    signal input new_blinding;       // 128-bit — fresh blinding for new balance commitment

    // -----------------------------------------------------------------------
    // Public inputs — on-chain commitments verified by the Solidity verifier
    // -----------------------------------------------------------------------
    signal input old_commit[2];      // Pedersen(old_value, old_blinding)
    signal input transfer_commit[2]; // Pedersen(transfer_value, transfer_blinding)
    signal input new_commit[2];      // Pedersen(old_value - transfer_value, new_blinding)

    // -----------------------------------------------------------------------
    // Step 1: Decompose old_value and old_blinding into bits
    // Pedersen(256): first 128 bits = value, next 128 bits = blinding (was 64+128=192)
    // -----------------------------------------------------------------------
    component bits_old_v = Num2Bits(128);
    bits_old_v.in <== old_value;

    component bits_old_b = Num2Bits(128);
    bits_old_b.in <== old_blinding;

    component pedersen_old = Pedersen(256);
    var i;
    for (i = 0; i < 128; i++) {
        pedersen_old.in[i] <== bits_old_v.out[i];
    }
    for (i = 0; i < 128; i++) {
        pedersen_old.in[128 + i] <== bits_old_b.out[i];
    }

    // Consistency check: recomputed commitment == public input
    pedersen_old.out[0] === old_commit[0];
    pedersen_old.out[1] === old_commit[1];

    // -----------------------------------------------------------------------
    // Step 2: Decompose transfer_value and transfer_blinding into bits
    // -----------------------------------------------------------------------
    component bits_tx_v = Num2Bits(128);
    bits_tx_v.in <== transfer_value;

    component bits_tx_b = Num2Bits(128);
    bits_tx_b.in <== transfer_blinding;

    component pedersen_tx = Pedersen(256);
    for (i = 0; i < 128; i++) {
        pedersen_tx.in[i] <== bits_tx_v.out[i];
    }
    for (i = 0; i < 128; i++) {
        pedersen_tx.in[128 + i] <== bits_tx_b.out[i];
    }

    // Consistency check: recomputed commitment == public input
    pedersen_tx.out[0] === transfer_commit[0];
    pedersen_tx.out[1] === transfer_commit[1];

    // -----------------------------------------------------------------------
    // Step 3: Range check — transfer_value in [0, 2^128)
    // Num2Bits(128) above already enforces this by decomposing into 128 bits.
    // The constraint is implicit: if transfer_value >= 2^128 the witness would
    // not satisfy the bit decomposition constraints.
    // No extra component needed — Num2Bits IS the range proof.
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // Step 4: Underflow prevention — transfer_value <= old_value
    // LessEqThan(128) works for values up to 2^128 (was LessEqThan(64)).
    // -----------------------------------------------------------------------
    component leq = LessEqThan(128);
    leq.in[0] <== transfer_value;
    leq.in[1] <== old_value;
    leq.out === 1;  // transfer_value <= old_value (underflow impossible)

    // -----------------------------------------------------------------------
    // Step 5: Compute new balance and verify new_commit
    // new_balance = old_value - transfer_value  (guaranteed non-negative above)
    // -----------------------------------------------------------------------
    signal new_balance;
    new_balance <== old_value - transfer_value;

    component bits_new_v = Num2Bits(128);
    bits_new_v.in <== new_balance;

    component bits_new_b = Num2Bits(128);
    bits_new_b.in <== new_blinding;

    component pedersen_new = Pedersen(256);
    for (i = 0; i < 128; i++) {
        pedersen_new.in[i] <== bits_new_v.out[i];
    }
    for (i = 0; i < 128; i++) {
        pedersen_new.in[128 + i] <== bits_new_b.out[i];
    }

    // Consistency check: recomputed new commitment == public input
    pedersen_new.out[0] === new_commit[0];
    pedersen_new.out[1] === new_commit[1];
}

component main {public [
    old_commit,
    transfer_commit,
    new_commit
]} = ConfidentialTransfer();
