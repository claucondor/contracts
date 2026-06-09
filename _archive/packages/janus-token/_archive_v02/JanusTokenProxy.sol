// SPDX-License-Identifier: MIT
//
// JanusTokenProxy.sol — ERC1967 proxy wrapper for JanusToken UUPS implementation.
//
// This file exists so the standard OpenZeppelin ERC1967Proxy is included in
// hardhat's compilation artifacts. No code changes — pure re-export.
//
// Deployment flow:
//   1. Deploy JanusToken (the UUPS implementation contract, uninitialized).
//   2. Encode initialize(...) calldata.
//   3. Deploy JanusTokenProxy(impl, initData) — proxy calls impl.initialize() in its
//      own storage context.
//   4. All subsequent interactions go through the proxy address.
//
// Upgrade flow:
//   - Owner calls proxy.upgradeToAndCall(newImpl, data) which delegates to
//     JanusToken._authorizeUpgrade (onlyOwner) → swaps the impl pointer.

pragma solidity ^0.8.20;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract JanusTokenProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data)
    {}
}
