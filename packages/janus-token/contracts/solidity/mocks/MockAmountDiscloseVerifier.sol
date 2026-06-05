// SPDX-License-Identifier: MIT
// Mock AmountDiscloseVerifier — returns true for all proofs.
// FOR TESTING ONLY. NOT for production use.
pragma solidity ^0.8.20;

contract MockAmountDiscloseVerifier {
    function verifyProof(
        uint[2] calldata,
        uint[2][2] calldata,
        uint[2] calldata,
        uint[3] calldata
    ) external pure returns (bool) {
        return true;
    }
}
