// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusFlow_v0_5_2.sol — JanusFlow UUPS implementation v0.5.2.
//
// Changes from v0.5:
//   * Native snapshot events on every state-changing op:
//       WrapWithSnapshot       — emitted on every wrap()
//       ShieldedTransferWithSnapshot — emitted on every shieldedTransfer()
//       UnwrapWithSnapshot     — emitted on every unwrap()
//     Callers pass (encryptedSnapshot, ephPubkeyX, ephPubkeyY) via calldata.
//     The contract emits them verbatim — zero on-chain crypto, pure transport.
//   * publishMemoKey(uint256, uint256) — stores caller's BabyJub pubkey in
//     memoKeyPubX/Y mappings for universal pubkey discovery.
//   * MemoKeyPublished event.
//   * VERSION "0.5.2".
//   * Old wrap/unwrap/shieldedTransfer signatures removed (breaking change —
//     testnet hard reset makes this safe; proxy preserved, only impl changes).
//
// Storage layout changes (appended to JanusToken's __gap):
//   JanusToken.__gap shrinks by 2:
//     slot N+0  — mapping(address => uint256) memoKeyPubX
//     slot N+1  — mapping(address => uint256) memoKeyPubY
//   All existing slots are UNCHANGED (no insertions before existing fields).
//
// Backwards-compat events KEPT:
//   Wrapped, ShieldedTransferred, Unwrapped — still emitted in parallel with
//   the new *WithSnapshot events so existing indexers keep working.

pragma solidity ^0.8.20;

import {JanusToken, IAmountDiscloseVerifier, IConfidentialTransferVerifier} from "./JanusToken.sol";

contract JanusFlow_v0_5_2 is JanusToken {
    // -----------------------------------------------------------------------
    // Version
    // -----------------------------------------------------------------------

    string public constant VERSION = "0.5.2";

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

    // -----------------------------------------------------------------------
    // Events — new (v0.5.2)
    // -----------------------------------------------------------------------

    /// Emitted on wrap(). `encryptedSnapshot` is an ECIES ciphertext of
    /// (balance, blinding) after the wrap, encrypted to the caller's MemoKey
    /// pubkey. `ephPubkeyX/Y` is the ephemeral key for decryption.
    event WrapWithSnapshot(
        address indexed user,
        uint256 amount,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    /// Emitted on shieldedTransfer(). Snapshot captures sender's RESIDUAL
    /// balance after sending, encrypted to the sender's MemoKey pubkey.
    event ShieldedTransferWithSnapshot(
        address indexed sender,
        address indexed recipient,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    /// Emitted on unwrap(). Snapshot captures sender's RESIDUAL balance
    /// after the unwrap (i.e., C_new), encrypted to the sender's MemoKey pubkey.
    event UnwrapWithSnapshot(
        address indexed user,
        uint256 amount,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    /// Emitted when a user registers or rotates their BabyJub memo pubkey.
    event MemoKeyPublished(address indexed user, uint256 pubkeyX, uint256 pubkeyY);

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
    // MemoKey registry (new in v0.5.2)
    // -----------------------------------------------------------------------

    /// @notice Register or update the caller's BabyJub pubkey for encrypted
    /// snapshot / memo reception. Anyone can call this once they have derived
    /// their BabyJub keypair via the sign-derive pattern (no privkey on chain).
    ///
    /// @param pubkeyX  BabyJub pubkey X coordinate
    /// @param pubkeyY  BabyJub pubkey Y coordinate
    function publishMemoKey(uint256 pubkeyX, uint256 pubkeyY) external {
        memoKeyPubX[msg.sender] = pubkeyX;
        memoKeyPubY[msg.sender] = pubkeyY;
        emit MemoKeyPublished(msg.sender, pubkeyX, pubkeyY);
    }

    // -----------------------------------------------------------------------
    // Public wrap / unwrap (v0.5.2 — snapshot params added)
    // -----------------------------------------------------------------------

    /// @notice Deposit `msg.value` of native FLOW into a hidden balance.
    ///
    /// v0.5.2: Pass (encryptedSnapshot, ephPubkeyX, ephPubkeyY) to emit a
    /// WrapWithSnapshot event. Pass empty bytes + 0n/0n to skip snapshot
    /// emission (not recommended — defeats recovery).
    ///
    /// @param txCommit          Pedersen commitment (Cx, Cy) of msg.value
    /// @param amountProof       Groth16 amount-disclose proof (8 limbs)
    /// @param encryptedSnapshot ECIES ciphertext of (balance, blinding) after wrap
    /// @param ephPubkeyX        Ephemeral BabyJub pubkey X for snapshot ECIES
    /// @param ephPubkeyY        Ephemeral BabyJub pubkey Y for snapshot ECIES
    function wrap(
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external payable {
        _wrap(msg.value, txCommit, amountProof);
        emit WrapWithSnapshot(msg.sender, msg.value, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    /// @notice Release `claimedAmount` of native FLOW to `recipient`.
    ///
    /// v0.5.2: encryptedSnapshot captures the residual shielded balance
    /// (C_new amount + blinding) after the unwrap.
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
    // shieldedTransfer (overrides base — adds snapshot params)
    // -----------------------------------------------------------------------

    /// @notice Transfer a HIDDEN amount from caller's commitment to `to`.
    ///
    /// v0.5.2: encryptedSnapshot captures the SENDER's residual balance after
    /// the transfer (C_new), encrypted to the sender's MemoKey pubkey.
    ///
    /// Overrides JanusToken.shieldedTransfer to add snapshot params. The full
    /// transfer logic is inlined here (identical to base) because the base
    /// function is not marked virtual/abstract — replication is the only option
    /// without modifying the shared base contract.
    ///
    /// @param to                  Recipient EVM address
    /// @param publicInputs        Transfer proof public inputs (6 limbs):
    ///                              [0..1]=C_old, [2..3]=C_tx, [4..5]=C_new
    /// @param proof               Groth16 transfer proof (8 limbs)
    /// @param encryptedSnapshot   Sender's residual balance snapshot (C_new state)
    /// @param ephPubkeyX          Ephemeral BabyJub pubkey X for ECIES decryption
    /// @param ephPubkeyY          Ephemeral BabyJub pubkey Y for ECIES decryption
    function shieldedTransfer(
        address to,
        uint256[6] calldata publicInputs,
        uint256[8] calldata proof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external {
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
