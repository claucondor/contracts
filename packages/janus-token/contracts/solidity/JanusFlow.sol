// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusFlow.sol — Native-FLOW confidential token.
// Inherits JanusToken (abstract base, v0.7.0).
// Uses 2-generator Pedersen aggregate commitment for homomorphic accumulation.

pragma solidity ^0.8.20;

import {JanusToken} from "./JanusToken.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract JanusFlow is JanusToken {
    uint256 public constant MAX_WRAP = type(uint128).max;
    string  public constant VERSION  = "0.7.0";

    // -----------------------------------------------------------------------
    // Initializer — for new proxies
    // -----------------------------------------------------------------------

    function initialize(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _owner,
        address _memoRegistry,
        address _pedersen2Gen
    ) external initializer {
        __JanusToken_init(
            _babyJub,
            _transferVerifier,
            _amountDiscloseVerifier,
            _owner,
            _memoRegistry,
            _pedersen2Gen
        );
    }

    // -----------------------------------------------------------------------
    // Public wrap — PAYABLE (msg.value carries the GROSS FLOW amount)
    // -----------------------------------------------------------------------

    function wrap(
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external payable {
        require(msg.value > 0, "JanusFlow: zero wrap");
        _recordFirstSnapshot(msg.sender);

        (uint256 fee, uint256 net) = _calcFee(msg.value);

        if (fee > 0) {
            (bool feeOk, ) = feeRecipient.call{value: fee}("");
            require(feeOk, "JanusFlow: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "wrap");
        }

        _wrap(net, txCommit, amountProof);

        emit WrapWithSnapshot(msg.sender, net, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    // -----------------------------------------------------------------------
    // Public unwrap
    // -----------------------------------------------------------------------

    function unwrap(
        uint256 claimedAmount,
        address payable recipient,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        uint256[6] calldata transferPublicInputs,
        uint256[8] calldata transferProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external {
        _recordFirstSnapshot(msg.sender);
        _unwrap(claimedAmount, recipient, txCommit, amountProof, transferPublicInputs, transferProof);
        emit UnwrapWithSnapshot(msg.sender, recipient, claimedAmount, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    // -----------------------------------------------------------------------
    // Template-method overrides
    // -----------------------------------------------------------------------

    function _wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof
    ) internal override {
        require(amount > 0,         "JanusFlow: zero net wrap");
        require(amount <= MAX_WRAP, "JanusFlow: exceeds MAX_WRAP");

        require(
            _verifyAmountDisclose(amount, txCommit, amountProof),
            "JanusFlow: invalid amount_disclose proof"
        );

        _acceptShieldedCredit(msg.sender, txCommit);
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
        require(claimedAmount > 0,            "JanusFlow: zero unwrap");
        require(recipient != address(0),      "JanusFlow: zero recipient");
        require(totalLocked >= claimedAmount, "JanusFlow: pool exhausted");

        require(
            _verifyAmountDisclose(claimedAmount, txCommit, amountProof),
            "JanusFlow: invalid amount_disclose proof"
        );

        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            transferPublicInputs[0] == senderCommit.x &&
            transferPublicInputs[1] == senderCommit.y,
            "JanusFlow: C_old mismatch"
        );

        require(
            transferPublicInputs[2] == txCommit[0] &&
            transferPublicInputs[3] == txCommit[1],
            "JanusFlow: C_tx mismatch between proofs"
        );

        require(
            _verifyTransferProof(transferPublicInputs, transferProof),
            "JanusFlow: invalid transfer proof"
        );

        _processShieldedDebit(msg.sender, txCommit, transferPublicInputs);

        totalLocked -= claimedAmount;

        (uint256 fee, uint256 netToRecipient) = _calcFee(claimedAmount);

        if (fee > 0) {
            (bool feeOk, ) = feeRecipient.call{value: fee}("");
            require(feeOk, "JanusFlow: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "unwrap");
        }

        (bool sent, ) = recipient.call{value: netToRecipient}("");
        require(sent, "JanusFlow: FLOW transfer failed");

        emit Unwrapped(msg.sender, recipient, netToRecipient);
    }

    receive() external payable {
        revert("JanusFlow: bare FLOW deposit disabled - use wrap()");
    }
}

// ---------------------------------------------------------------------------
// JanusFlow_Proxy — thin ERC1967 wrapper for fresh proxy deployments.
// ---------------------------------------------------------------------------

contract JanusFlow_Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data)
    {}
}
