// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @title ShieldedCheckpoint
 * @notice Per-user encrypted state checkpoint for the Janus protocol.
 *
 * Semantics:
 *   - Only the checkpoint owner (msg.sender) can write/overwrite their checkpoint.
 *   - Only the owner can read the full encrypted blob via read() — scoped to msg.sender
 *     for privacy (the blob is encrypted to owner's pubkey, but exposing it to anyone
 *     would signal a correlation attack vector).
 *   - Public metadata (lastConsumedNoteIndex, lastUpdatedBlock, version) is readable by
 *     anyone via metadata(address) — safe for indexers and recovery orchestration.
 *   - The contract is content-agnostic: encryptedSnapshot is opaque bytes.
 *   - Stores cursor (lastConsumedNoteIndex) to track how many ShieldedInbox notes the
 *     user has consumed into this checkpoint, enabling resume on partial drains.
 *   - Cursor monotonicity is NOT enforced — applications may rewind for rescans.
 *   - Empty snapshot (zero bytes) is valid — applications may use it to clear state.
 *
 * Design: immutable primitive — no upgradability, no owner, no pause.
 */
contract ShieldedCheckpoint {

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct Checkpoint {
        bytes    encryptedSnapshot;       // opaque payload encrypted to owner's pubkey
        uint256  ephPubkeyX;              // ECIES ephemeral pubkey X-coordinate
        uint256  ephPubkeyY;              // ECIES ephemeral pubkey Y-coordinate
        uint64   lastConsumedNoteIndex;   // cursor: inbox notes consumed into this checkpoint
        uint64   lastUpdatedBlock;        // block.number at the time of last update
        uint64   version;                 // monotonically increasing counter (1-indexed; 0 = no checkpoint)
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    mapping(address => Checkpoint) private _checkpoints;

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// 16 KB hard cap — double the ShieldedInbox note cap, allows richer state payloads.
    uint256 public constant MAX_SNAPSHOT_BYTES = 16384;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice Emitted on every successful update.
    event CheckpointUpdated(
        address indexed owner,
        uint64          version,
        uint64          lastConsumedNoteIndex,
        uint64          blockNumber
    );

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error SnapshotTooLarge();
    error NoCheckpoint();

    // -----------------------------------------------------------------------
    // External — write
    // -----------------------------------------------------------------------

    /**
     * @notice Create or overwrite the caller's checkpoint.
     *
     * @param encryptedSnapshot  Opaque encrypted state blob (max MAX_SNAPSHOT_BYTES).
     *                           Empty bytes are valid — useful to signal a cleared state.
     * @param ephPubkeyX         X-coordinate of the ECIES ephemeral public key used to
     *                           encrypt the snapshot.
     * @param ephPubkeyY         Y-coordinate of the ECIES ephemeral public key.
     * @param lastConsumedNoteIndex  Cursor: how many ShieldedInbox notes have been
     *                               consumed into this checkpoint.  Monotonicity is NOT
     *                               enforced; callers may rewind for rescans.
     */
    function update(
        bytes calldata encryptedSnapshot,
        uint256        ephPubkeyX,
        uint256        ephPubkeyY,
        uint64         lastConsumedNoteIndex
    ) external {
        if (encryptedSnapshot.length > MAX_SNAPSHOT_BYTES) revert SnapshotTooLarge();

        Checkpoint storage cp = _checkpoints[msg.sender];
        uint64 newVersion = cp.version + 1;

        cp.encryptedSnapshot     = encryptedSnapshot;
        cp.ephPubkeyX            = ephPubkeyX;
        cp.ephPubkeyY            = ephPubkeyY;
        cp.lastConsumedNoteIndex = lastConsumedNoteIndex;
        cp.lastUpdatedBlock      = uint64(block.number);
        cp.version               = newVersion;

        emit CheckpointUpdated(msg.sender, newVersion, lastConsumedNoteIndex, uint64(block.number));
    }

    // -----------------------------------------------------------------------
    // External — owner-only read
    // -----------------------------------------------------------------------

    /**
     * @notice Read the caller's own full checkpoint (includes encrypted blob).
     *
     * Scoped to msg.sender by design: the encrypted blob should not be exposed to
     * arbitrary callers even though it is encrypted — doing so leaks correlation signals.
     *
     * @return cp  Full Checkpoint struct including encryptedSnapshot.
     *
     * Reverts NoCheckpoint if the caller has never called update().
     */
    function read() external view returns (Checkpoint memory cp) {
        cp = _checkpoints[msg.sender];
        if (cp.version == 0) revert NoCheckpoint();
    }

    // -----------------------------------------------------------------------
    // External — public read (metadata only)
    // -----------------------------------------------------------------------

    /**
     * @notice Read non-sensitive metadata for any user.  Does NOT include the
     *         encrypted snapshot.  Safe for indexers, relayers, and recovery UI.
     *
     * @param user  Address whose metadata to read.
     * @return lastConsumedNoteIndex  Cursor value from the last update.
     * @return lastUpdatedBlock       Block number of the last update (0 if none).
     * @return version                Update counter (0 if no checkpoint exists).
     * @return hasCheckpoint          True if the user has at least one checkpoint update.
     */
    function metadata(address user) external view returns (
        uint64 lastConsumedNoteIndex,
        uint64 lastUpdatedBlock,
        uint64 version,
        bool   hasCheckpoint
    ) {
        Checkpoint storage cp = _checkpoints[user];
        return (cp.lastConsumedNoteIndex, cp.lastUpdatedBlock, cp.version, cp.version > 0);
    }

    /**
     * @notice Cheap existence check.  True once the user has called update() at least once.
     */
    function exists(address user) external view returns (bool) {
        return _checkpoints[user].version > 0;
    }
}
