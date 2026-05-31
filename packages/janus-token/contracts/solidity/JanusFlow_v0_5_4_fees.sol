// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusFlow_v0_5_4_fees.sol — JanusFlow UUPS implementation v0.5.4-fees.
//
// Changes from v0.5.3:
//   * Fee mechanism at BOUNDARIES ONLY (wrap + unwrap). ShieldedTransfer is
//     untouched — amounts are hidden there, fee computation would break privacy.
//   * New state (appended — no existing slots disturbed):
//       feeRecipient — admin-controlled wallet that accumulates protocol fees.
//       feeBps       — fee rate in basis points (10 = 0.1%). Mutable by owner.
//       MAX_FEE_BPS  — immutable hard cap: 100 bps (1%) prevents rug exposure.
//   * initFees(address, uint16) — one-time post-upgrade setter. Callable only
//     when feeRecipient == address(0) AND feeBps == 0 (defaults). Must be
//     called immediately after upgradeToAndCall.
//   * setFeeRecipient(address) / setFeeBps(uint16) — owner-callable setters.
//   * On wrap: fee deducted from msg.value; proof binds to netAmount.
//     User's commitment encodes the net (post-fee) FLOW deposited.
//   * On unwrap: fee deducted from claimedAmount; recipient receives the net.
//     Proof binds to the full claimedAmount (pre-fee) — this is intentional;
//     the circuit validates the amount the user controls in their commitment,
//     and the fee is deducted at the ETH transfer layer, not the proof layer.
//   * FeeCollected, FeeRecipientChanged, FeeBpsChanged events.
//   * VERSION "0.5.4-fees".

pragma solidity ^0.8.20;

import {JanusToken, IAmountDiscloseVerifier, IConfidentialTransferVerifier} from "./JanusToken.sol";

contract JanusFlow_v0_5_4_fees is JanusToken {
    // -----------------------------------------------------------------------
    // Version
    // -----------------------------------------------------------------------

    string public constant VERSION = "0.5.4-fees";

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// Per-call wrap cap: 2^128 attoFLOW — matches 128-bit Num2Bits in v0.5+
    /// circuits. Effectively unbounded for all realistic FLOW amounts.
    uint256 public constant MAX_WRAP = type(uint128).max;

    /// Maximum fee rate: 100 bps = 1%. Hard cap to prevent rug exposure.
    uint16 public constant MAX_FEE_BPS = 100;

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
    mapping(address => uint256) public firstSnapshotBlock;

    /// Fee recipient — admin-controlled wallet that collects protocol fees
    /// from wrap and unwrap boundary operations. Fees accumulate here and
    /// must be withdrawn manually by the operator.
    address public feeRecipient;

    /// Fee rate in basis points. 10 = 0.1%. Hard cap: MAX_FEE_BPS (100 = 1%).
    uint16 public feeBps;

    // -----------------------------------------------------------------------
    // Events — fee events (new in v0.5.4-fees)
    // -----------------------------------------------------------------------

    /// Emitted on every successful fee payment (wrap or unwrap boundary).
    event FeeCollected(address indexed user, uint256 fee, string op);

    /// Emitted when the fee recipient address is changed.
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);

    /// Emitted when the fee rate (in bps) is changed.
    event FeeBpsChanged(uint16 oldBps, uint16 newBps);

    // -----------------------------------------------------------------------
    // Events — inherited from v0.5.2 / v0.5.3 (unchanged)
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
    // Fee initializer — one-time post-upgrade call
    //
    // Must be called by the owner immediately after upgradeToAndCall().
    // Guard: both feeRecipient and feeBps must still be at their zero
    // defaults to prevent re-initialization.
    // -----------------------------------------------------------------------

    /// @notice One-time post-upgrade fee initializer.
    /// @dev    MUST be called immediately after upgrading the proxy to this
    ///         impl. Guard: reverts if either feeRecipient != address(0) OR
    ///         feeBps != 0 (i.e., already initialized).
    function initFees(address recipient, uint16 bps) external onlyOwner {
        require(
            feeRecipient == address(0) && feeBps == 0,
            "JanusFlow: fees already initialized"
        );
        require(recipient != address(0), "JanusFlow: zero feeRecipient");
        require(bps <= MAX_FEE_BPS, "JanusFlow: exceeds MAX_FEE_BPS");
        feeRecipient = recipient;
        feeBps = bps;
        emit FeeRecipientChanged(address(0), recipient);
        emit FeeBpsChanged(0, bps);
    }

    // -----------------------------------------------------------------------
    // Fee admin setters
    // -----------------------------------------------------------------------

    /// @notice Update the fee recipient address.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "JanusFlow: zero feeRecipient");
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientChanged(old, newRecipient);
    }

    /// @notice Update the fee rate. Hard-capped at MAX_FEE_BPS (100 = 1%).
    function setFeeBps(uint16 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "JanusFlow: exceeds MAX_FEE_BPS");
        uint16 old = feeBps;
        feeBps = newBps;
        emit FeeBpsChanged(old, newBps);
    }

    // -----------------------------------------------------------------------
    // Internal fee helper — transfer fee to recipient, non-fatal if bps==0
    // -----------------------------------------------------------------------

    function _collectFee(uint256 grossAmount, string memory op) internal returns (uint256 netAmount) {
        if (feeBps == 0 || feeRecipient == address(0)) {
            return grossAmount;
        }
        uint256 fee = (grossAmount * feeBps) / 10000;
        netAmount = grossAmount - fee;
        if (fee > 0) {
            (bool ok, ) = feeRecipient.call{value: fee}("");
            require(ok, "JanusFlow: fee transfer failed");
            emit FeeCollected(msg.sender, fee, op);
        }
        return netAmount;
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
    // Public wrap — v0.5.4-fees: fee deducted from msg.value before proof
    // -----------------------------------------------------------------------

    /// @notice Deposit `msg.value` of native FLOW into a hidden balance.
    ///
    /// v0.5.4-fees: A fee of `feeBps / 10000` is deducted from msg.value
    /// and forwarded to `feeRecipient` BEFORE the amount-disclose proof is
    /// verified. The proof therefore binds to `netAmount` (msg.value - fee),
    /// not to msg.value. The user's Pedersen commitment encodes only the net.
    ///
    /// The caller MUST build `txCommit` and `amountProof` for the NET amount:
    ///   netAmount = msg.value * (10000 - feeBps) / 10000
    ///
    /// If feeBps == 0, netAmount == msg.value (no change from v0.5.3 behavior).
    function wrap(
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external payable {
        require(msg.value > 0, "JanusFlow: zero wrap");

        _recordFirstSnapshot();

        // Deduct fee and forward to recipient; netAmount goes into the pool.
        uint256 netAmount = _collectFee(msg.value, "wrap");

        _wrap(netAmount, txCommit, amountProof);
        emit WrapWithSnapshot(msg.sender, netAmount, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    /// @notice Release `claimedAmount` of native FLOW. Recipient receives
    /// `claimedAmount - fee`; `fee` is forwarded to `feeRecipient`.
    ///
    /// v0.5.4-fees: The proof binds to `claimedAmount` (the full amount the
    /// user is spending from their commitment). The fee is deducted at the
    /// ETH-transfer layer AFTER proof verification, so the ZK circuit is
    /// unaffected. Recipient gets `claimedAmount * (10000 - feeBps) / 10000`.
    ///
    /// If feeBps == 0, recipient gets claimedAmount (no change from v0.5.3).
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
    // shieldedTransfer — NO FEE. Amounts are hidden; fee computation would
    // require knowing the transferred amount, breaking privacy. Unchanged
    // from v0.5.3.
    // -----------------------------------------------------------------------

    function shieldedTransfer(
        address to,
        uint256[6] calldata publicInputs,
        uint256[8] calldata proof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external {
        _recordFirstSnapshot();
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

        commitments[msg.sender] = Point({ x: publicInputs[4], y: publicInputs[5] });

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
    // Template-method overrides
    // -----------------------------------------------------------------------

    /// @dev Called from the public wrap() after fee deduction. `amount` is
    /// the NET amount (post-fee). The proof must bind to this net amount.
    function _wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof
    ) internal override {
        require(amount > 0,           "JanusFlow: zero net wrap");
        require(amount <= MAX_WRAP,   "JanusFlow: exceeds MAX_WRAP");

        require(
            _verifyAmountDisclose(amount, txCommit, amountProof),
            "JanusFlow: invalid amount_disclose proof"
        );

        _acceptShieldedCredit(msg.sender, txCommit);

        totalLocked += amount;

        emit Wrapped(msg.sender, amount);
    }

    /// @dev Called from the public unwrap() with the FULL claimedAmount (pre-
    /// fee). Proof verifies against claimedAmount. Fee is taken after proof
    /// verification inside the _unwrapFee path — the internal _unwrap sends
    /// the full claimedAmount to the recipient call, but we override the
    /// recipient transfer here to split fee + net.
    ///
    /// DESIGN NOTE: _unwrap in JanusToken.sol does the proof checks then sends
    /// `claimedAmount` to `recipient`. In v0.5.4-fees we override _unwrap to
    /// intercept the transfer: the proof still binds to claimedAmount, but we
    /// split into fee + net before sending.
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

        // Book-keep the full claimed amount (fee is protocol income, not
        // pool reduction — the fee recipient receives their share, and the
        // pool shrinks by claimedAmount in aggregate).
        totalLocked -= claimedAmount;

        // Compute fee and send fee to recipient, then net to user's recipient.
        uint256 fee = (feeBps > 0 && feeRecipient != address(0))
            ? (claimedAmount * feeBps) / 10000
            : 0;
        uint256 netToRecipient = claimedAmount - fee;

        if (fee > 0) {
            (bool feeOk, ) = feeRecipient.call{value: fee}("");
            require(feeOk, "JanusFlow: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "unwrap");
        }

        (bool sent, ) = recipient.call{value: netToRecipient}("");
        require(sent, "JanusFlow: FLOW transfer failed");

        emit Unwrapped(msg.sender, recipient, netToRecipient);
    }

    // -----------------------------------------------------------------------
    // Receive — disabled (FLOW must enter only via wrap to be tracked)
    // -----------------------------------------------------------------------

    receive() external payable {
        revert("JanusFlow: bare FLOW deposit disabled - use wrap()");
    }
}
