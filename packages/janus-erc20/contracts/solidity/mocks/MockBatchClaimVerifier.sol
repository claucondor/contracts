// SPDX-License-Identifier: MIT
// MockBatchClaimVerifier — returns true for all proofs.
// FOR TESTING ONLY. NOT for production use.
// Matches ConfidentialClaimBatchVerifier interface: 6 public inputs
// [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
pragma solidity ^0.8.20;

contract MockBatchClaimVerifier {
    function verifyProof(
        uint[2] calldata,
        uint[2][2] calldata,
        uint[2] calldata,
        uint[6] calldata
    ) external pure returns (bool) {
        return true;
    }
}
