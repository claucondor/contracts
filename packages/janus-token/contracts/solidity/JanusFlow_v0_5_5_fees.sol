// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusFlow_v0_5_5_fees.sol — JanusFlow UUPS implementation v0.5.5-fees.
//
// Changes from v0.5.4-fees:
//   * Overrides adminResetSlot(address) from JanusToken to ALSO clear
//     firstSnapshotBlock[user] to 0. The base-class version (JanusToken.sol)
//     only resets commitments[user] to identity (0, 1). This override ensures
//     that after a recovery reset the user's firstSnapshotBlock is cleared so
//     future snapshot scans start from 0 (i.e., from the next wrap event).
//
//   * VERSION "0.5.5-fees".
//
// STORAGE LAYOUT: Inherits ALL storage from JanusFlow_v0_5_4_fees.
// NO new state variables are introduced in this contract — only a function
// override and a VERSION constant. UUPS storage-layout compatible.
//
// TESTNET-ONLY: adminResetSlot is gated by block.chainid == 545 (Flow EVM
// testnet) in the base class. This override preserves that guard — the
// require(block.chainid == 545, ...) check runs in super.adminResetSlot()
// before we get to the firstSnapshotBlock reset. This contract is NOT intended
// for mainnet. See MAINNET-PREPARE-CHECKLIST.md (entry 1).

pragma solidity ^0.8.20;

import "./JanusFlow_v0_5_4_fees.sol";

/// @title JanusFlow v0.5.5-fees
/// @notice Overrides adminResetSlot() to also clear firstSnapshotBlock[user].
/// @dev Inherits ALL storage from JanusFlow_v0_5_4_fees (no new state vars).
///      Storage layout is fully compatible with UUPS upgrade from v0.5.4-fees.
contract JanusFlow_v0_5_5_fees is JanusFlow_v0_5_4_fees {
    // -----------------------------------------------------------------------
    // Override: adminResetSlot
    //
    // Adds firstSnapshotBlock[user] = 0 to the base-class reset so that
    // after recovery the user's snapshot scan window also resets to 0.
    //
    // Guard chain (enforced by both this override and the super call):
    //   1. onlyOwner (inherited from OwnableUpgradeable via JanusToken)
    //   2. block.chainid == 545 (enforced inside JanusToken.adminResetSlot)
    //   3. user != address(0) (enforced inside JanusToken.adminResetSlot)
    //
    // Side effects:
    //   * commitments[user] := identity point (0, 1)  ← done by super
    //   * firstSnapshotBlock[user] := 0               ← added here
    //   * totalSupplyCommitment INTENTIONALLY NOT updated (see JanusToken note)
    //   * totalLocked INTENTIONALLY NOT updated (independent of per-account state)
    //
    // PRIVACY-BREAKING: See JanusToken.adminResetSlot for the full privacy
    // warning. This override does not weaken or strengthen that contract.
    // -----------------------------------------------------------------------

    /// Flow EVM testnet chain id — mirrored from JanusToken to preserve guard.
    uint256 private constant FLOW_EVM_TESTNET_CHAIN_ID_V5 = 545;

    /// @notice TESTNET-ONLY: reset `user`'s shielded slot to identity AND
    ///         clear their firstSnapshotBlock to 0.
    /// @dev    Overrides JanusToken.adminResetSlot to also zero out
    ///         firstSnapshotBlock[user], so future snapshot scans start fresh.
    ///         All guards from the base class are replicated here:
    ///           - onlyOwner (inherited modifier)
    ///           - block.chainid == 545 (Flow EVM testnet only)
    ///           - user != address(0)
    ///         We cannot call super.adminResetSlot because Solidity does not
    ///         allow external functions to be invoked via super. The base-class
    ///         logic is replicated verbatim and the event is emitted by this
    ///         override. Both AdminSlotReset (from JanusToken) and
    ///         firstSnapshotBlock are written here.
    /// @param user The EVM address whose slot to reset.
    function adminResetSlot(address user) external override onlyOwner {
        require(
            block.chainid == FLOW_EVM_TESTNET_CHAIN_ID_V5,
            "JanusToken: adminResetSlot is testnet-only (chainId 545)"
        );
        require(user != address(0), "JanusToken: zero user");

        // Reset commitment to identity (0, 1) — replicates JanusToken logic.
        Point storage slot = commitments[user];
        uint256 priorX = slot.x;
        uint256 priorY = slot.y;
        slot.x = 0;
        slot.y = 1;

        // Emit the same event as the base class so indexers see it.
        emit AdminSlotReset(user, priorX, priorY);

        // Additional reset: clear the snapshot scan start block.
        firstSnapshotBlock[user] = 0;
    }
}
