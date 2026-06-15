// SPDX-License-Identifier: GPL-3.0
// Groth16Verifier.sol — Abstract base for Groth16 verifiers on BN254
//
// This file is a TEMPLATE. Do not deploy it directly.
// To create a verifier for your own circuit:
//
//   1. Compile your circuit with circom
//   2. Run: snarkjs groth16 setup ...
//   3. Run: snarkjs generateverifier --verification_key vk.json --output MyVerifier.sol
//   4. The generated contract replaces the constants below with your circuit's VK.
//
// Reference implementation: ConfidentialTransferVerifier.sol (same directory)
// Deployed at: 0x70FA331534619DBd4051b22b7fb19e647be141b0 (Flow EVM testnet)
//
// ---------------------------------------------------------------------------
// HOW GROTH16 VERIFICATION WORKS
// ---------------------------------------------------------------------------
//
// A Groth16 proof consists of three BN254 curve points:
//   pi_a ∈ G1  (2 field elements)
//   pi_b ∈ G2  (4 field elements — 2 Fp2 elements × 2 Fp each)
//   pi_c ∈ G1  (2 field elements)
//
// The verifier checks the pairing equation:
//   e(-pi_a, pi_b) * e(alpha, beta) * e(vk_x, gamma) * e(pi_c, delta) = 1
//
// where vk_x = IC[0] + Σ(pubSignals[i] * IC[i+1])
//       (linear combination of the public inputs with the IC verification key)
//
// The BN254 precompiles used:
//   0x06 ecAdd    — G1 point addition (150 gas)
//   0x07 ecMul    — G1 scalar multiplication (6,000 gas)
//   0x08 pairing  — BN254 pairing check (45,000 + 34,000*n gas)
//
// ---------------------------------------------------------------------------
// pi_b SWAP REQUIREMENT (EIP-197)
// ---------------------------------------------------------------------------
//
// snarkJS emits pi_b in (real, imaginary) order per Fp2 element.
// EIP-197 expects (imaginary, real) order.
// CALLERS MUST SWAP before passing _pB to verifyProof():
//
//   // snarkjs proof.pi_b = [[re0, im0], [re1, im1]]
//   // EVM expects:          [[im0, re0], [im1, re1]]
//   uint[2][2] memory pB = [
//     [proof.pi_b[0][1], proof.pi_b[0][0]],
//     [proof.pi_b[1][1], proof.pi_b[1][0]]
//   ];
//
// The @openjanus/groth16 TypeScript SDK handles this automatically.
//
// ---------------------------------------------------------------------------

pragma solidity >=0.7.0 <0.9.0;

// NOTE: This is a documentation template.
// The actual verifier with hardcoded constants is in ConfidentialTransferVerifier.sol.
// snarkJS generates concrete verifiers with `snarkjs generateverifier`.

// Interface for all circuit-specific verifiers generated from this pattern:
interface IGroth16Verifier {
    /**
     * @dev Verify a Groth16 proof against the embedded verification key.
     *
     * @param _pA   G1 point pi_a: [x, y]
     * @param _pB   G2 point pi_b: [[im0, re0], [im1, re1]] — NOTE: Fp2 coords SWAPPED vs snarkjs
     * @param _pC   G1 point pi_c: [x, y]
     * @param _pubSignals  Public inputs, in circuit declaration order
     * @return bool  true if the proof is valid, false otherwise
     *
     * IMPORTANT: This function uses staticcall to the BN254 precompiles.
     * It returns false (not reverts) if the precompile call fails or proof is invalid.
     * Always check the return value — a false result means the proof failed.
     */
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[] calldata _pubSignals
    ) external view returns (bool);
}
