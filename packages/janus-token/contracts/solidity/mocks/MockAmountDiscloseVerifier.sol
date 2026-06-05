// SPDX-License-Identifier: MIT
// MockAmountDiscloseVerifier — returns true for all proofs.
// FOR TESTING ONLY. NOT for production use.
// Matches AmountDiscloseAggregateVerifier interface: 4 public inputs [amount, commitX, commitY, nonce]
pragma solidity ^0.8.20;

contract MockAmountDiscloseVerifier {
    function verifyProof(
        uint[2] calldata,
        uint[2][2] calldata,
        uint[2] calldata,
        uint[4] calldata
    ) external pure returns (bool) {
        return true;
    }
}
