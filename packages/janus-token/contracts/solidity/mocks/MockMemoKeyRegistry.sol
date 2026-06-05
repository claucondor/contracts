// SPDX-License-Identifier: MIT
// Mock MemoKeyRegistry — returns zero keys for all users.
// FOR TESTING ONLY. NOT for production use.
pragma solidity ^0.8.20;

contract MockMemoKeyRegistry {
    function getMemoKey(address)
        external
        pure
        returns (uint256 x, uint256 y, uint256 publishedAt)
    {
        return (0, 0, 0);
    }
}
