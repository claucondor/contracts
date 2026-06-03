// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusERC20.sol — Confidential ERC20 wrapper.
// Inherits JanusToken (abstract base).  MemoKey stored in shared MemoKeyRegistry.
//
// Storage (extends JanusToken, slot 91+):
//   slot  0..10  base state
//   slot 11..89  __gap[79]
//   slot 90      memoRegistry
//   slot 91      underlying
//   slot 92..111 __gapERC20[20]

pragma solidity ^0.8.20;

import {JanusToken} from "./JanusToken.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

contract JanusERC20 is JanusToken {
    uint256 public constant MAX_WRAP = type(uint128).max;

    // slot 91 — Solidity places derived state after the full base layout
    // (including the gap), so this lands at slot 91 regardless of gap size.
    address public underlying;

    uint256[20] private __gapERC20;

    // -----------------------------------------------------------------------
    // Initializer — for new proxies
    // -----------------------------------------------------------------------

    function initialize(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _underlying,
        address _owner,
        address _memoRegistry
    ) external initializer {
        require(_underlying != address(0), "JanusERC20: zero underlying");
        __JanusToken_init(
            _babyJub, _transferVerifier, _amountDiscloseVerifier, _owner, _memoRegistry
        );
        underlying = _underlying;
    }

    // -----------------------------------------------------------------------
    // Public wrap — NOT payable; amount is explicit.
    //
    // Caller must approve this contract for `amount` (gross) of `underlying`
    // before calling wrap().
    // -----------------------------------------------------------------------

    function wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external payable {
        require(msg.value == 0, "JanusERC20: msg.value must be zero");
        require(amount > 0,     "JanusERC20: zero wrap");
        _recordFirstSnapshot(msg.sender);

        bool okPull = IERC20(underlying).transferFrom(msg.sender, address(this), amount);
        require(okPull, "JanusERC20: transferFrom failed");

        (uint256 fee, uint256 net) = _calcFee(amount);

        if (fee > 0) {
            bool okFee = IERC20(underlying).transfer(feeRecipient, fee);
            require(okFee, "JanusERC20: fee transfer failed");
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
        require(amount > 0,         "JanusERC20: zero net wrap");
        require(amount <= MAX_WRAP, "JanusERC20: exceeds MAX_WRAP");

        require(
            _verifyAmountDisclose(amount, txCommit, amountProof),
            "JanusERC20: invalid amount_disclose proof"
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
        require(claimedAmount > 0,            "JanusERC20: zero unwrap");
        require(recipient != address(0),      "JanusERC20: zero recipient");
        require(totalLocked >= claimedAmount, "JanusERC20: pool exhausted");

        require(
            _verifyAmountDisclose(claimedAmount, txCommit, amountProof),
            "JanusERC20: invalid amount_disclose proof"
        );

        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            transferPublicInputs[0] == senderCommit.x &&
            transferPublicInputs[1] == senderCommit.y,
            "JanusERC20: C_old mismatch"
        );

        require(
            transferPublicInputs[2] == txCommit[0] &&
            transferPublicInputs[3] == txCommit[1],
            "JanusERC20: C_tx mismatch between proofs"
        );

        require(
            _verifyTransferProof(transferPublicInputs, transferProof),
            "JanusERC20: invalid transfer proof"
        );

        _processShieldedDebit(msg.sender, txCommit, transferPublicInputs);

        totalLocked -= claimedAmount;

        (uint256 fee, uint256 netToRecipient) = _calcFee(claimedAmount);

        if (fee > 0) {
            bool okFee = IERC20(underlying).transfer(feeRecipient, fee);
            require(okFee, "JanusERC20: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "unwrap");
        }

        bool okSend = IERC20(underlying).transfer(recipient, netToRecipient);
        require(okSend, "JanusERC20: transfer failed");

        emit Unwrapped(msg.sender, recipient, netToRecipient);
    }

    // -----------------------------------------------------------------------
    // View helpers
    // -----------------------------------------------------------------------

    function underlyingBalance() external view returns (uint256) {
        return IERC20(underlying).balanceOf(address(this));
    }
}

// ---------------------------------------------------------------------------
// JanusERC20_Proxy — thin ERC1967 wrapper.
// ---------------------------------------------------------------------------

contract JanusERC20_Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data)
    {}
}
