// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusFlow.sol — Native-FLOW confidential token.
// Inherits JanusToken (abstract base).
// Uses 2-generator Pedersen aggregate commitment for homomorphic accumulation.
// Integrates ShieldedInbox for atomic note delivery on shieldedTransfer (v0.8.0).

pragma solidity ^0.8.20;

import {JanusToken} from "./JanusToken.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract JanusFlow is JanusToken {
    uint256 public constant MAX_WRAP = type(uint128).max;
    string  public constant VERSION  = "0.8.1";

    // -----------------------------------------------------------------------
    // Initializer — for new proxies
    // -----------------------------------------------------------------------

    /// @notice Initialize a new JanusFlow proxy.
    /// @param _babyJub                  BabyJubJub curve helper contract.
    /// @param _transferVerifier         ConfidentialTransfer Groth16 verifier.
    /// @param _amountDiscloseVerifier   AmountDisclose Groth16 verifier.
    /// @param _owner                    Initial owner (UUPS upgrade authority).
    /// @param _memoRegistry             Shared MemoKeyRegistry for recipient pubkeys.
    /// @param _pedersen2Gen             2-generator Pedersen commitment library.
    /// @param _inboxAddress             ShieldedInbox contract for atomic note delivery.
    ///                                  May be address(0) to deploy without inbox.
    /// @param _batchClaimVerifier       ConfidentialClaimBatchVerifier (pot22) for claimBatch().
    ///                                  May be address(0) — set later via setBatchClaimVerifier().
    function initialize(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _owner,
        address _memoRegistry,
        address _pedersen2Gen,
        address _inboxAddress,
        address _batchClaimVerifier
    ) external initializer {
        __JanusToken_init(
            _babyJub,
            _transferVerifier,
            _amountDiscloseVerifier,
            _owner,
            _memoRegistry,
            _pedersen2Gen,
            _inboxAddress,
            _batchClaimVerifier
        );
    }

    // -----------------------------------------------------------------------
    // Public wrapWithProof — PAYABLE (msg.value carries the GROSS FLOW amount)
    //
    // Requires a Groth16 proof from the AmountDiscloseAggregate circuit proving:
    //   Commit(amount, blinding) = (commitX, commitY)
    // where amount == msg.value (after any fee deduction: net amount).
    //
    // Public input layout: [amount, commitX, commitY, nonce]
    //   - amount:  net wrap amount in attoFLOW (must equal msg.value after fee)
    //   - commit:  the Pedersen commitment point being credited to the caller
    //   - nonce:   caller-chosen unique anti-replay value
    //
    // @param nonce     Anti-replay nonce. Must be unused for msg.sender.
    // @param commit    [commitX, commitY] — Pedersen commitment for this wrap.
    // @param pA        Groth16 proof element A.
    // @param pB        Groth16 proof element B.
    // @param pC        Groth16 proof element C.
    // -----------------------------------------------------------------------

    /// @notice Wrap native FLOW into a shielded commitment with anti-replay proof.
    /// @param nonce             Anti-replay nonce. Must be unused for msg.sender.
    /// @param commit            [commitX, commitY] — Pedersen commitment for this wrap.
    /// @param pA                Groth16 proof element A.
    /// @param pB                Groth16 proof element B.
    /// @param pC                Groth16 proof element C.
    /// @param encryptedSnapshot ECIES-encrypted snapshot of (value, blinding) for state recovery.
    /// @param ephPubkeyX        Ephemeral public key X coordinate used in ECIES encryption.
    /// @param ephPubkeyY        Ephemeral public key Y coordinate used in ECIES encryption.
    function wrapWithProof(
        uint256 nonce,
        uint256[2] calldata commit,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external payable {
        require(msg.value > 0, "JanusFlow: zero wrap");
        _recordFirstSnapshot(msg.sender);

        require(!usedNonces[msg.sender][nonce], "JanusFlow: nonce used");
        usedNonces[msg.sender][nonce] = true;

        (uint256 fee, uint256 net) = _calcFee(msg.value);

        if (fee > 0) {
            (bool feeOk, ) = feeRecipient.call{value: fee}("");
            require(feeOk, "JanusFlow: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "wrap");
        }

        // Build flat proof array for internal helper
        uint256[8] memory proofArr = [pA[0], pA[1], pB[0][0], pB[0][1], pB[1][0], pB[1][1], pC[0], pC[1]];
        uint256[2] memory commitMem = [commit[0], commit[1]];

        _wrapWithProofInternal(net, commitMem, proofArr, nonce);

        emit WrapWithSnapshot(msg.sender, net, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    /// @dev Internal implementation called after nonce/fee checks.
    function _wrapWithProofInternal(
        uint256 amount,
        uint256[2] memory txCommit,
        uint256[8] memory amountProof,
        uint256 nonce
    ) internal {
        require(amount > 0,         "JanusFlow: zero net wrap");
        require(amount <= MAX_WRAP, "JanusFlow: exceeds MAX_WRAP");

        // Verify the amount-disclose proof: proves commit = [amount]G + [blinding]H
        require(
            amountDiscloseVerifier.verifyProof(
                [amountProof[0], amountProof[1]],
                [[amountProof[2], amountProof[3]], [amountProof[4], amountProof[5]]],
                [amountProof[6], amountProof[7]],
                [amount, txCommit[0], txCommit[1], nonce]
            ),
            "JanusFlow: invalid amount_disclose proof"
        );

        // Accumulate commitment into caller's shielded balance
        Point memory current = _effectiveCommitment(msg.sender);
        (uint256 nx, uint256 ny) = pedersen2Gen.addCommits(
            current.x, current.y,
            txCommit[0], txCommit[1]
        );
        commitments[msg.sender] = Point({ x: nx, y: ny });

        (uint256 sx, uint256 sy) = pedersen2Gen.addCommits(
            totalSupplyCommitment.x, totalSupplyCommitment.y,
            txCommit[0], txCommit[1]
        );
        totalSupplyCommitment = Point({ x: sx, y: sy });

        totalLocked += amount;

        emit Wrapped(msg.sender, amount);
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

    /// @dev _wrap is not called directly by any public function in this contract.
    /// wrapWithProof() handles the full wrap path including proof verification.
    /// This override is required by the abstract base; it reverts if called.
    function _wrap(
        uint256,
        uint256[2] calldata,
        uint256[8] calldata,
        uint256
    ) internal pure override {
        revert("JanusFlow: use wrapWithProof");
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

        // For unwrap, nonce is 0 — the transfer proof already provides replay
        // protection via the commitment state machine (C_old must match on-chain state).
        require(
            _verifyAmountDisclose(claimedAmount, txCommit, amountProof, 0),
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
        revert("JanusFlow: bare FLOW deposit disabled - use wrapWithProof()");
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
