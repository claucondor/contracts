// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusFlow_v0_5_3.sol — JanusFlow UUPS implementation v0.5.3.
//
// Changes from v0.5.2:
//   * firstSnapshotBlock mapping added (appended — no existing slots disturbed):
//       firstSnapshotBlock[user] → block number of user's FIRST snapshot event.
//     Set on first call to wrap(), shieldedTransfer() (for both sender and
//     recipient), and unwrap(). Remains zero until first interaction.
//     SDK recovery scanner reads this via one eth_call to know exactly where
//     to start paginating instead of scanning from a fixed block window.
//   * Privacy impact: ZERO. The first activity block is already publicly
//     observable via event logs. Mapping makes it O(1) instead of O(N).
//   * VERSION "0.5.3".

pragma solidity ^0.8.20;

import {JanusToken, IAmountDiscloseVerifier, IConfidentialTransferVerifier} from "./JanusToken.sol";

contract JanusFlow_v0_5_3 is JanusToken {
    // -----------------------------------------------------------------------
    // Version
    // -----------------------------------------------------------------------

    string public constant VERSION = "0.5.3";

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// Per-call wrap cap: 2^128 attoFLOW — matches 128-bit Num2Bits in v0.5+
    /// circuits. Effectively unbounded for all realistic FLOW amounts.
    uint256 public constant MAX_WRAP = type(uint128).max;

    // -----------------------------------------------------------------------
    // New state (appended — no existing slots disturbed)
    // -----------------------------------------------------------------------

    /// BabyJub pubkey X coordinate for memo/snapshot encryption (per user).
    mapping(address => uint256) public memoKeyPubX;

    /// BabyJub pubkey Y coordinate for memo/snapshot encryption (per user).
    mapping(address => uint256) public memoKeyPubY;

    /// Block number of each user's FIRST snapshot event. Set on first wrap,
    /// shieldedTransfer (sender AND recipient), or unwrap. Remains 0 until
    /// the user has interacted with the contract at least once.
    ///
    /// SDK recovery scanner reads this to know where to start paginating
    /// instead of scanning from block 0 or relying on a fixed block window.
    /// Privacy impact: ZERO — the first activity block is already publicly
    /// observable via event logs; this mapping makes it O(1) instead of O(N).
    mapping(address => uint256) public firstSnapshotBlock;

    // -----------------------------------------------------------------------
    // Events — inherited from v0.5.2 (unchanged)
    // -----------------------------------------------------------------------

    event WrapWithSnapshot(
        address indexed user,
        uint256 amount,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    event ShieldedTransferWithSnapshot(
        address indexed sender,
        address indexed recipient,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    event UnwrapWithSnapshot(
        address indexed user,
        uint256 amount,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    event MemoKeyPublished(address indexed user, uint256 pubkeyX, uint256 pubkeyY);

    event VerifiersRotated(
        address indexed oldAmount,
        address indexed newAmount,
        address indexed oldTransfer,
        address newTransfer
    );

    // -----------------------------------------------------------------------
    // Internal helper — record first snapshot block (no-op after first call)
    // -----------------------------------------------------------------------

    /// @dev Set firstSnapshotBlock[msg.sender] = block.number on their first
    /// interaction. Subsequent calls are free no-ops (gas: one SLOAD warm).
    function _recordFirstSnapshot() internal {
        if (firstSnapshotBlock[msg.sender] == 0) {
            firstSnapshotBlock[msg.sender] = block.number;
        }
    }

    // -----------------------------------------------------------------------
    // Initializer (unchanged interface — proxy was already initialized)
    // -----------------------------------------------------------------------

    function initialize(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _owner
    ) external initializer {
        __JanusToken_init(_babyJub, _transferVerifier, _amountDiscloseVerifier, _owner);
    }

    // -----------------------------------------------------------------------
    // Verifier rotation (retained from v0.5)
    // -----------------------------------------------------------------------

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
    // MemoKey registry (retained from v0.5.2)
    // -----------------------------------------------------------------------

    function publishMemoKey(uint256 pubkeyX, uint256 pubkeyY) external {
        memoKeyPubX[msg.sender] = pubkeyX;
        memoKeyPubY[msg.sender] = pubkeyY;
        emit MemoKeyPublished(msg.sender, pubkeyX, pubkeyY);
    }

    // -----------------------------------------------------------------------
    // Public wrap / unwrap (v0.5.3 — firstSnapshotBlock recording added)
    // -----------------------------------------------------------------------

    /// @notice Deposit `msg.value` of native FLOW into a hidden balance.
    ///
    /// v0.5.3: Records firstSnapshotBlock[caller] on first call so the SDK
    /// scanner knows exactly where to start paginating.
    function wrap(
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external payable {
        _recordFirstSnapshot();
        _wrap(msg.value, txCommit, amountProof);
        emit WrapWithSnapshot(msg.sender, msg.value, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    /// @notice Release `claimedAmount` of native FLOW to `recipient`.
    ///
    /// v0.5.3: Records firstSnapshotBlock[caller] on first call.
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
        _recordFirstSnapshot();
        _unwrap(
            claimedAmount,
            recipient,
            txCommit,
            amountProof,
            transferPublicInputs,
            transferProof
        );
        emit UnwrapWithSnapshot(msg.sender, claimedAmount, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    // -----------------------------------------------------------------------
    // shieldedTransfer (v0.5.3 — firstSnapshotBlock for sender AND recipient)
    // -----------------------------------------------------------------------

    /// @notice Transfer a HIDDEN amount from caller's commitment to `to`.
    ///
    /// v0.5.3: Records firstSnapshotBlock for both the sender (caller) and
    /// the recipient so both parties can recover their history from the hint.
    function shieldedTransfer(
        address to,
        uint256[6] calldata publicInputs,
        uint256[8] calldata proof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external {
        _recordFirstSnapshot();
        // Also record the hint for the recipient (they receive a credit here).
        if (firstSnapshotBlock[to] == 0) {
            firstSnapshotBlock[to] = block.number;
        }

        require(to != address(0),  "JanusToken: transfer to zero address");
        require(to != msg.sender,  "JanusToken: cannot transfer to self");

        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            publicInputs[0] == senderCommit.x && publicInputs[1] == senderCommit.y,
            "JanusToken: C_old mismatch"
        );

        require(
            _verifyTransferProof(publicInputs, proof),
            "JanusToken: invalid transfer proof"
        );

        // Sender commitment becomes C_new
        commitments[msg.sender] = Point({ x: publicInputs[4], y: publicInputs[5] });

        // Recipient commitment += C_tx (homomorphic)
        Point memory recvCommit = _effectiveCommitment(to);
        (uint256 rx, uint256 ry) = babyJub.babyAdd(
            recvCommit.x, recvCommit.y,
            publicInputs[2], publicInputs[3]
        );
        commitments[to] = Point({ x: rx, y: ry });

        emit ConfidentialTransfer(msg.sender, to);
        emit ShieldedTransferWithSnapshot(msg.sender, to, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    // -----------------------------------------------------------------------
    // Template-method overrides (unchanged logic from v0.5)
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
