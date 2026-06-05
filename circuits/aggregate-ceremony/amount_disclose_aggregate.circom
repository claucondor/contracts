pragma circom 2.0.0;

// ============================================================================
// WARN: not for production — test zkey only, single-contributor ceremony
// This circuit is a lab spike for architecture validation.
// A multi-party trusted-setup ceremony is required before mainnet deployment.
// See: modules/zk/aggregate-pedersen/docs/DESIGN.md
// ============================================================================

include "../../confidential-transfer-circuit/node_modules/circomlib/circuits/babyjub.circom";
include "../../confidential-transfer-circuit/node_modules/circomlib/circuits/bitify.circom";

//
// AmountDiscloseAggregate — wrap-time binding circuit
//
// Proves that a submitted Pedersen commitment point encodes the wrap amount
// msg.value with a valid blinding factor. This closes the wrap-binding gap:
// without this proof, a caller could submit a commitment for amount' ≠ msg.value
// and accumulate an incorrect value into their on-chain state.
//
// Construction:
//   Commit(amount, blinding) = [amount]·G + [blinding]·H
//
// where G and H are the same generators as ConfidentialTransferAggregate:
//   G = Base8 (prime-order subgroup generator, [l]*G = identity)
//   H = NUMS generator derived via SHA-256(seed) mod l * G
//
// ─────────────────────────────────────────────────────────────────────────────
// Public input layout (order is fixed — SDK and contract ABI depend on this):
//   [0] amount    = wrap amount (== msg.value on-chain; not hideable)
//   [1] commitX   = commitment x-coordinate
//   [2] commitY   = commitment y-coordinate
//   [3] nonce     = anti-replay nonce; enforced by contract storage mapping
//
// Private inputs:
//   blinding      = 252-bit scalar; Commit(amount, blinding) = (commitX, commitY)
//
// Hardening features encoded in this single circuit:
//   #1 — Amount binding:     prove commit = [amount]G + [blinding]H (main constraint)
//   #2 — Range check amount: amount < 2^128  (Num2Bits(128) decomposition)
//   #3 — Range check blinding: blinding < 2^252  (Num2Bits(252) decomposition)
//   #4 — Nonce binding:     nonce appears in witness (nonceCheck = nonce*nonce)
//                           enforced by contract storage, bound cryptographically here
//
// Note on #4: The nonce value is a public input, so it is already included in
// the Groth16 proof's public statement. The dummy constraint (nonce*nonce) is a
// belt-and-suspenders measure that forces nonce into the R1CS witness unconditionally.
// The anti-replay guarantee comes from the contract's usedNonces mapping, not from
// the circuit — the circuit merely ensures the nonce cannot be stripped from the proof
// without invalidating it.
//
// ─────────────────────────────────────────────────────────────────────────────
// Generator G (= Base8, prime-order subgroup generator of BabyJubJub):
//   G_x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
//   G_y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
//   NOTE: G = Base8 = 8 × (raw BabyJub generator). The raw generator is NOT
//   in the prime-order subgroup (it has full order 8×l). We MUST use Base8 here
//   so that [l]*G = identity, which is required for the homomorphism to hold.
//
// Generator H (NUMS — SHA-256("cadence-crypto-lab:aggregate-pedersen:generator-H:v1") mod l * G):
//   H_x = 20176122646359037043957983780698997220241005801156909477756461731029015465513
//   H_y = 12675495183377259114213499882541802147068931119123218019653136042509354750865
//
// Scalar derivation:
//   seed       = "cadence-crypto-lab:aggregate-pedersen:generator-H:v1"
//   sha256     = dab770fa437522466cc77e342af81afeeea9cf70e63ad98b83463b5819288b13
//   scalar     = 431220823411395456446588864425906976884578672973864058140779376804016099631
// ─────────────────────────────────────────────────────────────────────────────

template AmountDiscloseAggregate() {
    // ── Public inputs ──────────────────────────────────────────────────────────
    signal input amount;     // wrap amount, == msg.value on-chain; not hideable
    signal input commitX;    // x-coordinate of Commit(amount, blinding)
    signal input commitY;    // y-coordinate of Commit(amount, blinding)
    signal input nonce;      // anti-replay nonce, enforced by contract storage

    // ── Private input ─────────────────────────────────────────────────────────
    signal input blinding;   // 252-bit blinding scalar; opens the commitment

    // ─────────────────────────────────────────────────────────────────────────
    // Hardening #2: Range check amount — amount < 2^128
    // Num2Bits(128) constrains `amount` to a 128-bit binary decomposition.
    // If amount >= 2^128, the component is unsatisfiable and proof generation fails.
    // ─────────────────────────────────────────────────────────────────────────
    component amountBits = Num2Bits(128);
    amountBits.in <== amount;

    // ─────────────────────────────────────────────────────────────────────────
    // Hardening #3: Range check blinding — blinding < 2^252
    // Num2Bits(252) constrains `blinding` to a 252-bit binary decomposition.
    // The BabyJubJub prime-order subgroup has order l < 2^252, so this window
    // covers the full valid scalar range. Proof generation fails if blinding >= 2^252.
    // ─────────────────────────────────────────────────────────────────────────
    component blindingBits = Num2Bits(252);
    blindingBits.in <== blinding;

    // ─────────────────────────────────────────────────────────────────────────
    // G = Base8 (prime-order subgroup generator of BabyJubJub)
    // H = NUMS second generator (identical to ConfidentialTransferAggregate)
    // These values must be kept in sync with:
    //   - Pedersen2Gen template in confidential_transfer_aggregate.circom
    //   - Pedersen2Gen.sol (on-chain verification)
    //   - js/commitment.ts (off-chain proof generation)
    // ─────────────────────────────────────────────────────────────────────────
    var G[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];
    var H[2] = [
        20176122646359037043957983780698997220241005801156909477756461731029015465513,
        12675495183377259114213499882541802147068931119123218019653136042509354750865
    ];

    // ─────────────────────────────────────────────────────────────────────────
    // Hardening #1: Compute [amount]·G using 128-bit scalar
    // EscalarMulFix(128, G) performs fixed-base scalar multiplication.
    // The bit decomposition from amountBits feeds directly into the multiplier.
    // ─────────────────────────────────────────────────────────────────────────
    component amountG = EscalarMulFix(128, G);
    var i;
    for (i = 0; i < 128; i++) {
        amountG.e[i] <== amountBits.out[i];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Compute [blinding]·H using 252-bit scalar
    // EscalarMulFix(252, H) provides full subgroup coverage.
    // ─────────────────────────────────────────────────────────────────────────
    component blindingH = EscalarMulFix(252, H);
    for (i = 0; i < 252; i++) {
        blindingH.e[i] <== blindingBits.out[i];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Add the two points: result = [amount]·G + [blinding]·H
    // ─────────────────────────────────────────────────────────────────────────
    component addGH = BabyAdd();
    addGH.x1 <== amountG.out[0];
    addGH.y1 <== amountG.out[1];
    addGH.x2 <== blindingH.out[0];
    addGH.y2 <== blindingH.out[1];

    // ─────────────────────────────────────────────────────────────────────────
    // Hardening #1 (continued): constrain result == submitted commitment
    // This is the primary binding constraint:
    //   [amount]·G + [blinding]·H == (commitX, commitY)
    // ─────────────────────────────────────────────────────────────────────────
    addGH.xout === commitX;
    addGH.yout === commitY;

    // ─────────────────────────────────────────────────────────────────────────
    // Hardening #4: Bind nonce into witness
    // nonce is already a public input (included in the Groth16 proof statement).
    // This dummy quadratic constraint forces nonce into the R1CS witness
    // unconditionally, preventing any future optimizer from eliding it.
    // The anti-replay guarantee is provided by the contract's usedNonces mapping;
    // the circuit merely ensures the nonce cannot be stripped from the proof.
    // ─────────────────────────────────────────────────────────────────────────
    signal nonceCheck;
    nonceCheck <== nonce * nonce;
}

component main {public [amount, commitX, commitY, nonce]} = AmountDiscloseAggregate();
