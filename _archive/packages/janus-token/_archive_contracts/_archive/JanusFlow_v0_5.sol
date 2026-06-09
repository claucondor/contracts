// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusFlow_v0_5.sol — JanusFlow UUPS implementation v0.5.
//
// Changes from v0.3:
//   * MAX_WRAP bumped from 2^64 (18 FLOW) to 2^128 attoFLOW — removes the
//     cap that blocked high-value wraps. The confidential_transfer circuit
//     now uses Num2Bits(128) so this matches the new proof headroom.
//   * VERSION constant added ("0.5.0").
//   * setVerifiers(newAmountDiscloseVerifier, newTransferVerifier) function
//     added so verifier addresses can be rotated after a new ceremony without
//     redeploying the proxy.
//
// Storage layout is IDENTICAL to JanusToken / JanusFlow v0.3 — no slots
// reordered, no insertions before existing fields. The __gap shrinks by 0
// (VERSION is a constant, not a storage variable; setVerifiers writes to
// existing slots 51 + 52).

pragma solidity ^0.8.20;

import {JanusToken, IAmountDiscloseVerifier, IConfidentialTransferVerifier} from "./JanusToken.sol";

contract JanusFlow_v0_5 is JanusToken {
    // -----------------------------------------------------------------------
    // Version
    // -----------------------------------------------------------------------

    string public constant VERSION = "0.5.0";

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// Per-call wrap cap bumped to 2^128 attoFLOW — matches the 128-bit
    /// Num2Bits range proof in confidential_transfer.circom v0.5.
    /// Realistic FLOW supply is far below this limit, so it is effectively
    /// unbounded for all practical purposes.
    uint256 public constant MAX_WRAP = type(uint128).max; // 2^128 - 1

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// Emitted when the owner rotates verifier contract addresses.
    event VerifiersRotated(
        address indexed oldAmount,
        address indexed newAmount,
        address indexed oldTransfer,
        address newTransfer
    );

    // -----------------------------------------------------------------------
    // Initializer (unchanged interface — proxy was already initialized)
    // -----------------------------------------------------------------------

    /// @notice Initialize a JanusFlow proxy.
    /// Called atomically from the ERC1967Proxy constructor via
    /// `abi.encodeCall(JanusFlow_v0_5.initialize, (...))`.
    /// Not called again after UUPS upgrade — existing proxy state is preserved.
    function initialize(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _owner
    ) external initializer {
        __JanusToken_init(_babyJub, _transferVerifier, _amountDiscloseVerifier, _owner);
    }

    // -----------------------------------------------------------------------
    // Verifier rotation — v0.5 new function
    // -----------------------------------------------------------------------

    /// @notice Rotate both verifier addresses atomically. Called by the owner
    /// after a new ceremony produces fresh proving/verification keys.
    /// @dev Writes to storage slots 51 (transferVerifier) and 52
    /// (amountDiscloseVerifier) — both pre-existing slots in JanusToken.
    /// No new storage is consumed.
    function setVerifiers(
        address newAmountDiscloseVerifier,
        address newTransferVerifier
    ) external onlyOwner {
        require(
            newAmountDiscloseVerifier != address(0) && newTransferVerifier != address(0),
            "JanusFlow: zero verifier"
        );
        address oldAmount   = address(amountDiscloseVerifier);
        address oldTransfer = address(transferVerifier);
        amountDiscloseVerifier = IAmountDiscloseVerifier(newAmountDiscloseVerifier);
        transferVerifier       = IConfidentialTransferVerifier(newTransferVerifier);
        emit VerifiersRotated(oldAmount, newAmountDiscloseVerifier, oldTransfer, newTransferVerifier);
    }

    // -----------------------------------------------------------------------
    // Public wrap / unwrap
    // -----------------------------------------------------------------------

    /// @notice Deposit `msg.value` of native FLOW into a hidden balance.
    /// @dev    `msg.value` is VISIBLE BY DESIGN — boundary leak.
    function wrap(
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof
    ) external payable {
        _wrap(msg.value, txCommit, amountProof);
    }

    /// @notice Release `claimedAmount` of native FLOW to `recipient` while
    /// keeping the sender's residual balance commitment hidden.
    function unwrap(
        uint256 claimedAmount,
        address payable recipient,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        uint256[6] calldata transferPublicInputs,
        uint256[8] calldata transferProof
    ) external {
        _unwrap(
            claimedAmount,
            recipient,
            txCommit,
            amountProof,
            transferPublicInputs,
            transferProof
        );
    }

    // -----------------------------------------------------------------------
    // Template-method overrides
    // -----------------------------------------------------------------------

    function _wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof
    ) internal override {
        require(amount > 0,           "JanusFlow: zero wrap");
        require(amount <= MAX_WRAP,   "JanusFlow: exceeds MAX_WRAP");

        require(
            _verifyAmountDisclose(amount, txCommit, amountProof),
            "JanusFlow: invalid amount_disclose proof"
        );

        _acceptShieldedCredit(msg.sender, txCommit);

        // Custody accounting (visible by design)
        totalLocked += amount;

        emit Wrapped(msg.sender, amount);
    }

    function _unwrap(
        uint256 claimedAmount,
        address payable recipient,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        uint256[6] calldata transferPublicInputs,
        uint256[8] calldata transferProof
    ) internal override {
        require(claimedAmount > 0,             "JanusFlow: zero unwrap");
        require(recipient != address(0),       "JanusFlow: zero recipient");
        require(totalLocked >= claimedAmount,  "JanusFlow: pool exhausted");

        // 1) amount_disclose: txCommit binds to claimedAmount
        require(
            _verifyAmountDisclose(claimedAmount, txCommit, amountProof),
            "JanusFlow: invalid amount_disclose proof"
        );

        // 2) Transfer proof must reference sender's current commitment.
        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            transferPublicInputs[0] == senderCommit.x &&
            transferPublicInputs[1] == senderCommit.y,
            "JanusFlow: C_old mismatch"
        );

        // 3) Same txCommit must be the C_tx in the transfer proof.
        require(
            transferPublicInputs[2] == txCommit[0] &&
            transferPublicInputs[3] == txCommit[1],
            "JanusFlow: C_tx mismatch between proofs"
        );

        // 4) Verify Groth16 transfer proof (C_new = C_old − C_tx + range).
        require(
            _verifyTransferProof(transferPublicInputs, transferProof),
            "JanusFlow: invalid transfer proof"
        );

        // 5) Apply shielded debit (sender → C_new ; totalSupplyCommitment -= C_tx)
        _processShieldedDebit(msg.sender, txCommit, transferPublicInputs);

        // 6) Release native FLOW (boundary leak — intentional).
        totalLocked -= claimedAmount;
        (bool sent, ) = recipient.call{value: claimedAmount}("");
        require(sent, "JanusFlow: FLOW transfer failed");

        emit Unwrapped(msg.sender, recipient, claimedAmount);
    }

    // -----------------------------------------------------------------------
    // Receive — disabled (FLOW must enter only via wrap to be tracked)
    // -----------------------------------------------------------------------

    receive() external payable {
        revert("JanusFlow: bare FLOW deposit disabled - use wrap()");
    }
}
