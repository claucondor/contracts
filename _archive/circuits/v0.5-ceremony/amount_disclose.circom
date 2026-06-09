pragma circom 2.0.0;

include "circomlib_local/circuits/pedersen.circom";
include "circomlib_local/circuits/bitify.circom";

//
// AmountDisclose v0.5 — bind a Pedersen commitment to a PUBLIC cleartext amount.
//
// Used by ConfidentialFLOW wrap/unwrap to enforce that the on-chain commitment
// (added on wrap, subtracted on unwrap) really commits to the visible amount.
//
// v0.5 changes vs v0.3:
//   - claimed_amount range check bumped from Num2Bits(64) → Num2Bits(128)
//   - Pedersen input width bumped from 192 → 256 bits (128 value + 128 blinding)
//   - Maximum wrappable amount is now 2^128 wei ≈ 3.4×10^38 (effectively unbounded)
//   - Public input shape UNCHANGED — same 3-element pubSignals layout
//
// Proves:
//   1. commit == Pedersen(claimed_amount, blinding)
//   2. claimed_amount in [0, 2^128)  (Num2Bits range check — was 64)
//   3. blinding in [0, 2^128)        (Num2Bits range check — unchanged)
//
// Public input layout (order matters for Solidity verifier — UNCHANGED from v0.3):
//   [0] claimed_amount  — cleartext amount (matches msg.value on wrap or claimedAmount on unwrap)
//   [1] commit[0]       — Pedersen commitment x-coordinate
//   [2] commit[1]       — Pedersen commitment y-coordinate
//
// Pedersen(256) is the SAME template used by confidential_transfer.circom v0.5 — so
// the resulting commit is interoperable: it can be added/subtracted via
// BabyJub.babyAdd against the L1 ConfidentialToken commitments.
//
// Trusted setup: pot18_hez.ptau (Hermez community ceremony, 200+ contributors).
//
template AmountDisclose() {
    // ---- Private input ----
    signal input blinding;          // 128-bit blinding factor

    // ---- Public inputs ----
    signal input claimed_amount;    // 128-bit cleartext amount (was 64-bit in v0.3)
    signal input commit[2];         // Pedersen commit (x, y) on BabyJubJub

    // ---- Step 1: range-check claimed_amount via 128-bit decomposition (was 64) ----
    component bits_v = Num2Bits(128);
    bits_v.in <== claimed_amount;

    // ---- Step 2: range-check blinding via 128-bit decomposition ----
    component bits_b = Num2Bits(128);
    bits_b.in <== blinding;

    // ---- Step 3: compute Pedersen(256) of (value || blinding) (was Pedersen(192)) ----
    component ped = Pedersen(256);
    var i;
    for (i = 0; i < 128; i++) {
        ped.in[i] <== bits_v.out[i];
    }
    for (i = 0; i < 128; i++) {
        ped.in[128 + i] <== bits_b.out[i];
    }

    // ---- Step 4: assert commit equals computed Pedersen ----
    ped.out[0] === commit[0];
    ped.out[1] === commit[1];
}

component main {public [
    claimed_amount,
    commit
]} = AmountDisclose();
