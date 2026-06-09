pragma circom 2.0.0;

// ============================================================================
// WARN: not for production — testnet only until multi-party ceremony completes
// A trusted-setup ceremony (≥3 contributors) is REQUIRED before mainnet use.
// Current security limitation: no on-chain note-consumption tracking. The
// C_consumed public input is not enforced against specific inbox entries by
// this circuit alone. See README.md § Security Model for full analysis and
// the recommended NoteCommitmentTracker mitigation for mainnet.
// ============================================================================

include "node_modules/circomlib/circuits/babyjub.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// ─────────────────────────────────────────────────────────────────────────────
// Generator constants (shared with ConfidentialTransferAggregate).
// Must stay in sync with:
//   - confidential_transfer_aggregate.circom (Pedersen2Gen template)
//   - Pedersen2Gen.sol (on-chain commit verification)
//   - @openjanus/commitment (JS computation)
//
// G = Base8 (prime-order subgroup generator of BabyJubJub, [l]·G = identity):
//   G_x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
//   G_y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
//
// H = NUMS second generator (SHA-256("openjanus:aggregate-pedersen:generator-H:v1") mod l · G):
//   H_x = 20176122646359037043957983780698997220241005801156909477756461731029015465513
//   H_y = 12675495183377259114213499882541802147068931119123218019653136042509354750865
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Pedersen2Gen — compute Commit(v, r) = [v]·G + [r]·H
//
// Identical to the template in confidential_transfer_aggregate.circom.
// Used for the 128-bit user balance commitments (C_old, C_new).
//
//   v  : 128-bit token balance
//   r  : 252-bit blinding scalar (full prime-order subgroup range)
//   out: (x, y) commitment point on BabyJubJub
// ─────────────────────────────────────────────────────────────────────────────
template Pedersen2Gen() {
    signal input v;
    signal input r;
    signal output out[2];

    var G[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    var H[2] = [
        20176122646359037043957983780698997220241005801156909477756461731029015465513,
        12675495183377259114213499882541802147068931119123218019653136042509354750865
    ];

    // [v]·G — 128-bit scalar
    component vBits = Num2Bits(128);
    vBits.in <== v;

    component vG = EscalarMulFix(128, G);
    var i;
    for (i = 0; i < 128; i++) {
        vG.e[i] <== vBits.out[i];
    }

    // [r]·H — 252-bit scalar (full subgroup coverage)
    component rBits = Num2Bits(252);
    rBits.in <== r;

    component rH = EscalarMulFix(252, H);
    for (i = 0; i < 252; i++) {
        rH.e[i] <== rBits.out[i];
    }

    // Commit = [v]·G + [r]·H
    component addGH = BabyAdd();
    addGH.x1 <== vG.out[0];
    addGH.y1 <== vG.out[1];
    addGH.x2 <== rH.out[0];
    addGH.y2 <== rH.out[1];

    out[0] <== addGH.xout;
    out[1] <== addGH.yout;
}

// ─────────────────────────────────────────────────────────────────────────────
// NoteCommit — compute Commit(amount, blinding) = [amount]·G + [blinding]·H
//
// Used for each individual inbox note commitment.
// Differs from Pedersen2Gen in that the amount is 64-bit (inbox notes are
// bounded per-note) and uses EscalarMulFix(64, G) for efficiency.
//
//   amount  : 64-bit note value (range-checked here)
//   blinding: 252-bit blinding scalar (range-checked here)
//   out     : (x, y) commitment point on BabyJubJub
// ─────────────────────────────────────────────────────────────────────────────
template NoteCommit() {
    signal input amount;
    signal input blinding;
    signal output out[2];

    var G[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    var H[2] = [
        20176122646359037043957983780698997220241005801156909477756461731029015465513,
        12675495183377259114213499882541802147068931119123218019653136042509354750865
    ];

    // Range-check: amount < 2^64
    component aBits = Num2Bits(64);
    aBits.in <== amount;

    component aG = EscalarMulFix(64, G);
    var i;
    for (i = 0; i < 64; i++) {
        aG.e[i] <== aBits.out[i];
    }

    // Range-check: blinding < 2^252
    component bBits = Num2Bits(252);
    bBits.in <== blinding;

    component bH = EscalarMulFix(252, H);
    for (i = 0; i < 252; i++) {
        bH.e[i] <== bBits.out[i];
    }

    // Commit = [amount]·G + [blinding]·H
    component addGH = BabyAdd();
    addGH.x1 <== aG.out[0];
    addGH.y1 <== aG.out[1];
    addGH.x2 <== bH.out[0];
    addGH.y2 <== bH.out[1];

    out[0] <== addGH.xout;
    out[1] <== addGH.yout;
}

// ─────────────────────────────────────────────────────────────────────────────
// ConfidentialClaimBatch(N) — batch drain N inbox notes in a single ZK proof
//
// Proves:
//   (1) User knows (oldBalance, oldBlinding) that open C_old.
//   (2) User knows N (amounts[i], blindings[i]) pairs with sane ranges.
//   (3) newBalance = oldBalance + Σ amounts[i]  (no overflow — newBalance < 2^128)
//   (4) C_new = Commit(newBalance, newBlinding) for user-chosen newBlinding.
//   (5) C_consumed = Σ Commit(amounts[i], blindings[i])  (accumulation is honest)
//
// Public inputs (seen by on-chain verifier):
//   C_old      — old commitment from on-chain storage; must match what JanusToken holds
//   C_new      — new commitment to write to on-chain storage
//   C_consumed — sum of consumed note commitments; contract verifies these existed
//                in the NoteCommitmentTracker (once deployed — see README § Limitations)
//
// Private inputs (never revealed on-chain):
//   oldBalance, oldBlinding — opens C_old
//   newBlinding             — fresh user-chosen blinding for C_new
//   amounts[N]              — per-note amounts (64-bit each)
//   blindings[N]            — per-note blindings (252-bit each)
//
// Constraint count estimate for N=50:
//   Pedersen2Gen (C_old): ~14 500 constraints
//   Pedersen2Gen (C_new): ~14 500 constraints
//   NoteCommit × 50:      ~11 500 × 50 = 575 000 constraints
//   BabyAdd × 50:         ~    50 × 7  =   3 500 constraints (accumulator chain)
//   Sum signals + misc:                 <   1 000 constraints
//   TOTAL:                            ≈ 608 500 constraints
//   → Minimum ptau: pot20 (2^20 = 1 048 576)
//   → Recommended:  pot21 for headroom; pot22 for ceremony (conservative, standard)
// ─────────────────────────────────────────────────────────────────────────────
template ConfidentialClaimBatch(N) {

    // ── Public inputs ──────────────────────────────────────────────────────────
    // Array layout matches Groth16 verifier ABI:
    //   [0] C_old[0]     = old commitment x
    //   [1] C_old[1]     = old commitment y
    //   [2] C_new[0]     = new commitment x
    //   [3] C_new[1]     = new commitment y
    //   [4] C_consumed[0]= consumed sum x
    //   [5] C_consumed[1]= consumed sum y
    signal input C_old[2];        // Commit(oldBalance, oldBlinding) — must match storage
    signal input C_new[2];        // Commit(newBalance, newBlinding) — written to storage
    signal input C_consumed[2];   // Σ Commit(amounts[i], blindings[i]) — validated externally

    // ── Private inputs ─────────────────────────────────────────────────────────
    signal input oldBalance;      // 128-bit — current hidden balance
    signal input oldBlinding;     // 252-bit — current blinding factor
    signal input newBlinding;     // 252-bit — fresh blinding for new commitment
    signal input amounts[N];      // 64-bit each — drained note amounts
    signal input blindings[N];    // 252-bit each — per-note blinding factors

    var i;

    // ── Step 1: Verify C_old = Commit(oldBalance, oldBlinding) ────────────────
    // Range checks on oldBalance (<2^128) and oldBlinding (<2^252) are performed
    // inside Pedersen2Gen by Num2Bits(128) and Num2Bits(252) respectively.
    component P_old = Pedersen2Gen();
    P_old.v <== oldBalance;
    P_old.r <== oldBlinding;
    P_old.out[0] === C_old[0];
    P_old.out[1] === C_old[1];

    // ── Step 2: Sum the note amounts ──────────────────────────────────────────
    // Running sum via intermediate signals (linear R1CS constraints).
    // Each amounts[i] is range-checked to 64 bits inside NoteCommit below.
    //
    // Maximum sum: 50 × (2^64 - 1) ≈ 2^69.6, well under the 2^128 newBalance cap.
    signal rSum[N+1];
    rSum[0] <== 0;
    for (i = 0; i < N; i++) {
        rSum[i+1] <== rSum[i] + amounts[i];
    }

    // ── Step 3: Compute newBalance and verify C_new ────────────────────────────
    // newBalance overflow: Num2Bits(128) inside Pedersen2Gen rejects if >= 2^128.
    // Any overflow from oldBalance + rSum[N] that wraps within the BN254 field
    // would produce a value near 2^254, which Num2Bits(128) rejects.
    signal newBalance;
    newBalance <== oldBalance + rSum[N];

    component P_new = Pedersen2Gen();
    P_new.v <== newBalance;
    P_new.r <== newBlinding;
    P_new.out[0] === C_new[0];
    P_new.out[1] === C_new[1];

    // ── Step 4: Compute each individual note commitment ────────────────────────
    // NoteCommit enforces: amounts[i] < 2^64, blindings[i] < 2^252.
    component nc[N];
    for (i = 0; i < N; i++) {
        nc[i] = NoteCommit();
        nc[i].amount   <== amounts[i];
        nc[i].blinding <== blindings[i];
    }

    // ── Step 5: Accumulate C_consumed = Σ nc[i].out ───────────────────────────
    // Chain: acc[0] = identity, acc[k+1] = BabyAdd(acc[k], nc[k].out)
    // Using N BabyAdds starting from the identity (0, 1).
    //
    // BabyAdd((0,1), P) = P for any P — verified by twisted-Edwards addition law.
    // This chain handles N=1 correctly and generalises to any N >= 1.
    component cAdd[N];
    for (i = 0; i < N; i++) {
        cAdd[i] = BabyAdd();
        // Left operand: identity on first iteration, previous accumulator thereafter
        if (i == 0) {
            cAdd[0].x1 <== 0;   // identity x
            cAdd[0].y1 <== 1;   // identity y
        } else {
            cAdd[i].x1 <== cAdd[i-1].xout;
            cAdd[i].y1 <== cAdd[i-1].yout;
        }
        // Right operand: the i-th note commitment
        cAdd[i].x2 <== nc[i].out[0];
        cAdd[i].y2 <== nc[i].out[1];
    }

    // ── Step 6: Constrain public C_consumed ───────────────────────────────────
    cAdd[N-1].xout === C_consumed[0];
    cAdd[N-1].yout === C_consumed[1];
}

component main {public [C_old, C_new, C_consumed]} = ConfidentialClaimBatch(50);
