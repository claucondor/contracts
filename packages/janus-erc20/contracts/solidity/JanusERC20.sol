// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusERC20.sol — Confidential ERC20 wrapper (v0.8.1).
// Inherits JanusToken abstract base v0.8.0 (ShieldedInbox integration).
//
// v0.8.1 changes:
//   - claimBatch() added to JanusERC20 directly (not the base) to avoid
//     slot collision: janus-token base adds batchClaimVerifier at slot 94, but
//     JanusERC20 already uses slot 94 for `underlying`.
//   - batchClaimVerifier stored at slot 95 (consuming one slot from __gapERC20;
//     gap reduced from uint256[50] to uint256[49]).
//   - setBatchClaimVerifier() admin setter added (owner-only).
//   - IBatchClaimVerifier interface added inline.
//   - VERSION bumped to "0.8.1".
//
// Changes from v0.7.0:
//   - JanusToken base upgraded to v0.8.0: ShieldedInbox at slot 93, shared
//     memoRegistry at slot 90, firstSnapshotBlock/feeRecipient/feeBps now in base.
//   - initialize() adds _inboxAddress as 8th arg; passed through to
//     __JanusToken_init (7-arg v0.8.0 signature).
//   - 9-arg shieldedTransfer (with senderSnapshot params) removed; base's
//     6-arg shieldedTransfer inherited — senders update ShieldedCheckpoint
//     in a separate composable call.
//   - ShieldedInbox.deposit called atomically on every shieldedTransfer
//     (handled by base; reverts if inbox full).
//   - adminBatchResetSlots inherited from base (MAX_BATCH_RESET = 100).
//   - Duplicate state vars (firstSnapshotBlock, feeRecipient, feeBps,
//     memoRegistry), events, and admin functions removed — now inherited.
//   - VERSION bumped to 0.8.0.
//
// ERC20 wrap/unwrap path unchanged: transferFrom pulls underlying from caller
// on wrap; transfer returns underlying to recipient on unwrap.

pragma solidity ^0.8.20;

import {JanusToken} from "./JanusToken.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// ---------------------------------------------------------------------------
// ERC20 interface (minimal — only the methods JanusERC20 calls)
// ---------------------------------------------------------------------------

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @dev ConfidentialClaimBatchVerifier — 6 public inputs (pot22 ceremony, N=50 notes).
/// Public input layout: [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
interface IBatchClaimVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[6] calldata _pubSignals
    ) external view returns (bool);
}

// ---------------------------------------------------------------------------
// JanusERC20 — concrete implementation for any ERC20 underlying
// ---------------------------------------------------------------------------

contract JanusERC20 is JanusToken {

    // Version sentinel — readable on-chain and in deployment manifests.
    string  public constant VERSION  = "0.8.1";

    // Hard cap on a single wrap (18e18 token units). Keeps individual
    // commitments well within the BabyJubJub subgroup order.
    uint256 public constant MAX_WRAP = 18_000_000_000_000_000_000;

    // -----------------------------------------------------------------------
    // Storage — slots after JanusToken base (slot 93 = shieldedInbox)
    //
    // LAYOUT NOTE: janus-erc20's JanusToken base ends at slot 93 (shieldedInbox).
    // Slot 94 is `underlying` — already deployed to testnet proxy.
    // Slot 95 is `batchClaimVerifier` — new in v0.8.1, consumed from __gapERC20.
    // The janus-token package adds batchClaimVerifier at slot 94 in its base
    // (JanusFlow has no child slots), but this package cannot do the same due to
    // the `underlying` slot already occupying slot 94 on deployed proxies.
    // -----------------------------------------------------------------------

    /// @notice The underlying ERC20 token held in escrow.
    address public underlying;                   // slot 94

    /// @dev Batch claim verifier — ConfidentialClaimBatchVerifier (pot22 ceremony, N=50).
    /// Set via initialize() for fresh deploys or setBatchClaimVerifier() post-upgrade.
    IBatchClaimVerifier public batchClaimVerifier; // slot 95

    /// @dev Reserved gap for future ERC20-specific state variables (reduced from 50 to 49).
    uint256[49] private __gapERC20;              // slots 96..144

    // -----------------------------------------------------------------------
    // Initializer — for new proxies (v0.8.0)
    // -----------------------------------------------------------------------

    /// @notice Initialize a new JanusERC20 proxy.
    /// @param _babyJub                  BabyJubJub curve helper contract.
    /// @param _transferVerifier         ConfidentialTransfer Groth16 verifier.
    /// @param _amountDiscloseVerifier   AmountDisclose Groth16 verifier.
    /// @param _underlying               ERC20 token to wrap (held in escrow).
    /// @param _owner                    Initial owner (UUPS upgrade authority).
    /// @param _memoRegistry             Shared MemoKeyRegistry for recipient pubkeys.
    /// @param _pedersen2Gen             2-generator Pedersen commitment library.
    /// @param _inboxAddress             ShieldedInbox for atomic note delivery.
    ///                                  May be address(0) for deployments without inbox.
    /// @param _batchClaimVerifier       ConfidentialClaimBatchVerifier (pot22) for claimBatch().
    ///                                  May be address(0) — set later via setBatchClaimVerifier().
    function initialize(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _underlying,
        address _owner,
        address _memoRegistry,
        address _pedersen2Gen,
        address _inboxAddress,
        address _batchClaimVerifier
    ) external initializer {
        require(_underlying != address(0), "JanusERC20: zero underlying");
        __JanusToken_init(
            _babyJub,
            _transferVerifier,
            _amountDiscloseVerifier,
            _owner,
            _memoRegistry,
            _pedersen2Gen,
            _inboxAddress
        );
        underlying = _underlying;
        if (_batchClaimVerifier != address(0)) {
            batchClaimVerifier = IBatchClaimVerifier(_batchClaimVerifier);
        }
    }

    // -----------------------------------------------------------------------
    // Public wrapWithProof (ERC20-specific)
    //
    // Pulls `amount` of the underlying ERC20 from the caller via transferFrom,
    // deducts any protocol fee, then verifies a Groth16 AmountDisclose proof
    // that the submitted Pedersen commitment encodes the net amount.
    //
    // Public input layout: [amount, commitX, commitY, nonce]
    //   - amount:  net wrap amount (ERC20 token units, after fee deduction)
    //   - commit:  the Pedersen commitment being credited to the caller
    //   - nonce:   caller-chosen unique anti-replay value
    // -----------------------------------------------------------------------

    /// @notice Wrap ERC20 tokens into a shielded commitment with anti-replay proof.
    /// @param amount            Gross ERC20 token amount to wrap (transferFrom pulls this).
    /// @param nonce             Anti-replay nonce. Must be unused for msg.sender.
    /// @param commit            [commitX, commitY] — Pedersen commitment for the net amount.
    /// @param pA                Groth16 proof element A.
    /// @param pB                Groth16 proof element B.
    /// @param pC                Groth16 proof element C.
    /// @param encryptedSnapshot ECIES-encrypted snapshot of (value, blinding) for state recovery.
    /// @param ephPubkeyX        Ephemeral public key X coordinate used in ECIES encryption.
    /// @param ephPubkeyY        Ephemeral public key Y coordinate used in ECIES encryption.
    function wrapWithProof(
        uint256 amount,
        uint256 nonce,
        uint256[2] calldata commit,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external {
        require(amount > 0, "JanusERC20: zero wrap");
        _recordFirstSnapshot(msg.sender);

        require(!usedNonces[msg.sender][nonce], "JanusERC20: nonce used");
        usedNonces[msg.sender][nonce] = true;

        // Pull gross amount from caller via ERC20 transferFrom.
        bool okPull = IERC20(underlying).transferFrom(msg.sender, address(this), amount);
        require(okPull, "JanusERC20: transferFrom failed");

        (uint256 fee, uint256 net) = _calcFee(amount);

        if (fee > 0) {
            bool okFee = IERC20(underlying).transfer(feeRecipient, fee);
            require(okFee, "JanusERC20: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "wrap");
        }

        require(net > 0,         "JanusERC20: zero net wrap");
        require(net <= MAX_WRAP, "JanusERC20: exceeds MAX_WRAP");

        // Verify amount-disclose proof: proves commit = [net]G + [blinding]H.
        require(
            amountDiscloseVerifier.verifyProof(
                [pA[0], pA[1]],
                [[pB[0][0], pB[0][1]], [pB[1][0], pB[1][1]]],
                [pC[0], pC[1]],
                [net, commit[0], commit[1], nonce]
            ),
            "JanusERC20: invalid amount_disclose proof"
        );

        // Accumulate commitment into caller's shielded balance (homomorphic).
        Point memory current = _effectiveCommitment(msg.sender);
        (uint256 nx, uint256 ny) = pedersen2Gen.addCommits(
            current.x, current.y,
            commit[0], commit[1]
        );
        commitments[msg.sender] = Point({ x: nx, y: ny });

        (uint256 sx, uint256 sy) = pedersen2Gen.addCommits(
            totalSupplyCommitment.x, totalSupplyCommitment.y,
            commit[0], commit[1]
        );
        totalSupplyCommitment = Point({ x: sx, y: sy });

        totalLocked += net;

        emit Wrapped(msg.sender, net);
        emit WrapWithSnapshot(msg.sender, net, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    // -----------------------------------------------------------------------
    // Public unwrap (ERC20-specific)
    //
    // Verifies an amount-disclose proof for the claimed amount and a transfer
    // proof demonstrating the sender has sufficient shielded balance.  Returns
    // the underlying ERC20 to `recipient` after deducting any protocol fee.
    // -----------------------------------------------------------------------

    /// @notice Unwrap ERC20 tokens from shielded balance and return to recipient.
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

    /// @dev _wrap is not called by any public function in this contract.
    /// wrapWithProof() handles the full wrap path directly.
    /// This override satisfies the abstract base requirement; reverts if called.
    function _wrap(
        uint256,
        uint256[2] calldata,
        uint256[8] calldata,
        uint256
    ) internal pure override {
        revert("JanusERC20: use wrapWithProof");
    }

    /// @dev _unwrap override — ERC20 transfer path.
    /// Verifies both proofs, debits the sender's commitment, and transfers
    /// underlying ERC20 (minus fee) to `recipient`.
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

        // For unwrap, nonce is 0 — the transfer proof provides replay protection
        // via the commitment state machine (C_old must match on-chain state).
        require(
            _verifyAmountDisclose(claimedAmount, txCommit, amountProof, 0),
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

    /// @notice Returns the contract's current balance of the underlying ERC20.
    function underlyingBalance() external view returns (uint256) {
        return IERC20(underlying).balanceOf(address(this));
    }

    // -----------------------------------------------------------------------
    // claimBatch — batch shielded-inbox claim (v0.8.1)
    //
    // Mirrors JanusToken.claimBatch (janus-token package) with identical logic.
    // Defined here rather than the base because `batchClaimVerifier` lives at
    // slot 95 in JanusERC20 (base slot 94 is occupied by `underlying`).
    //
    // Public input layout (6 signals):
    //   [0] C_old_x, [1] C_old_y — current commitment (circuit-bound to on-chain)
    //   [2] C_new_x, [3] C_new_y — new commitment after draining N notes
    //   [4] C_consumed_x, [5] C_consumed_y — sum of N note commitments
    //
    // Proof format uint256[8]: [pA[2], pB row0[2], pB row1[2], pC[2]] (snarkjs)
    //
    // Trust model: same as janus-token/JanusToken.sol — see that file for full docs.
    // v0.8 testnet: notes not marked consumed on-chain; mainnet fix requires
    // NoteCommitmentTracker.sol (planned post-v0.8).
    // -----------------------------------------------------------------------

    /// @notice Emitted when a user batch-claims N inbox notes in a single proof.
    event BatchClaimed(address indexed user, uint256 newCommitX, uint256 newCommitY);

    /// @notice Set or update the BatchClaimVerifier address. Owner-only.
    /// @dev Call after UUPS upgrade to wire slot 95 (zero until set).
    function setBatchClaimVerifier(address _verifier) external onlyOwner {
        require(_verifier != address(0), "JanusERC20: zero batchClaimVerifier");
        batchClaimVerifier = IBatchClaimVerifier(_verifier);
    }

    /// @notice Batch-claim up to 50 ShieldedInbox notes with a single Groth16 proof.
    /// @param publicInputs  [C_old_x, C_old_y, C_new_x, C_new_y, C_consumed_x, C_consumed_y]
    /// @param proof         Groth16 proof packed as [pA[2], pB[4], pC[2]] (snarkjs flat format).
    function claimBatch(
        uint256[6] calldata publicInputs,
        uint256[8] calldata proof
    ) external {
        require(
            address(batchClaimVerifier) != address(0),
            "JanusERC20: batchClaimVerifier not set"
        );

        // 1. Verify the Groth16 proof (pot22 ceremony).
        require(
            batchClaimVerifier.verifyProof(
                [proof[0], proof[1]],
                [[proof[2], proof[3]], [proof[4], proof[5]]],
                [proof[6], proof[7]],
                publicInputs
            ),
            "JanusERC20: invalid batch proof"
        );

        // 2. Verify C_old matches caller's current on-chain commitment.
        Point memory current = _effectiveCommitment(msg.sender);
        require(
            current.x == publicInputs[0] && current.y == publicInputs[1],
            "JanusERC20: C_old mismatch with stored commit"
        );

        // 3. Update commitment to C_new.
        commitments[msg.sender] = Point({ x: publicInputs[2], y: publicInputs[3] });

        emit BatchClaimed(msg.sender, publicInputs[2], publicInputs[3]);

        // NOTE(v0.8 testnet): inbox notes NOT marked consumed on-chain.
        // See circuits/aggregate-claim-batch/README.md §6 for mainnet fix.
    }
}

// ---------------------------------------------------------------------------
// JanusERC20_Proxy — thin ERC1967 wrapper for fresh proxy deployments.
// ---------------------------------------------------------------------------

contract JanusERC20_Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data)
    {}
}
