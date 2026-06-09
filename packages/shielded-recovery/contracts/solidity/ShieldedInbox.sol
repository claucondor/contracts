// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @title ShieldedInbox
 * @notice Per-user on-chain mailbox for receiving shielded notes.
 *
 * Semantics:
 *   - Anyone can deposit a ciphertext + ephemeral public key to any recipient.
 *   - Only the inbox owner (msg.sender) can drain their own notes.
 *   - Notes are returned FIFO.  drainBatch/drainAll advance a head pointer
 *     (no array shifts) and delete consumed storage slots for gas refunds.
 *   - The contract is deliberately content-agnostic: ciphertext is opaque bytes.
 *     Applications define their own payload schema on top.
 *
 * Design: immutable primitive — no upgradability, no owner, no pause.
 */
contract ShieldedInbox {

    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct Note {
        bytes    ciphertext;
        uint256  ephPubkeyX;
        uint256  ephPubkeyY;
        address  depositor;
        uint64   blockNumber;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// user => append-only array of notes (consumed slots zeroed, not shifted)
    mapping(address => Note[]) private _inboxes;

    /// user => index of the next unread note (FIFO head pointer)
    mapping(address => uint256) private _heads;

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 public constant MAX_CIPHERTEXT_BYTES = 8192;   // 8 KB hard cap
    uint256 public constant MAX_INBOX_NOTES      = 10000;  // overflow protection

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice Emitted on every successful deposit.
    event NoteDeposited(
        address indexed recipient,
        address indexed depositor,
        uint256         index
    );

    /// @notice Emitted after a drain operation removes at least one note.
    event NotesDrained(address indexed owner, uint256 count);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error CiphertextTooLarge();
    error InboxFull();

    // -----------------------------------------------------------------------
    // External — write
    // -----------------------------------------------------------------------

    /**
     * @notice Append a note to `recipient`'s inbox.
     * @param recipient   Who should receive the note.
     * @param ciphertext  Opaque encrypted payload (max MAX_CIPHERTEXT_BYTES).
     * @param ephPubkeyX  X-coordinate of the sender's ephemeral public key.
     * @param ephPubkeyY  Y-coordinate of the sender's ephemeral public key.
     */
    function deposit(
        address         recipient,
        bytes calldata  ciphertext,
        uint256         ephPubkeyX,
        uint256         ephPubkeyY
    ) external {
        if (ciphertext.length > MAX_CIPHERTEXT_BYTES) revert CiphertextTooLarge();

        // Pending notes = total length – head.  We check this because
        // consumed slots are zeroed but NOT removed from the array.
        uint256 pending = _inboxes[recipient].length - _heads[recipient];
        if (pending >= MAX_INBOX_NOTES) revert InboxFull();

        uint256 idx = _inboxes[recipient].length;
        _inboxes[recipient].push(Note({
            ciphertext:  ciphertext,
            ephPubkeyX:  ephPubkeyX,
            ephPubkeyY:  ephPubkeyY,
            depositor:   msg.sender,
            blockNumber: uint64(block.number)
        }));

        emit NoteDeposited(recipient, msg.sender, idx);
    }

    /**
     * @notice Drain up to `limit` oldest notes from caller's inbox.
     * @param limit  Maximum number of notes to return (0 returns nothing).
     * @return notes Drained notes in FIFO order.
     */
    function drainBatch(uint256 limit) external returns (Note[] memory notes) {
        return _drain(msg.sender, limit);
    }

    /**
     * @notice Drain all pending notes from caller's inbox.
     * @return notes All pending notes in FIFO order.
     */
    function drainAll() external returns (Note[] memory notes) {
        uint256 pending = _inboxes[msg.sender].length - _heads[msg.sender];
        return _drain(msg.sender, pending);
    }

    // -----------------------------------------------------------------------
    // External — view
    // -----------------------------------------------------------------------

    /**
     * @notice Number of unread notes pending for `user`.
     */
    function count(address user) external view returns (uint256) {
        return _inboxes[user].length - _heads[user];
    }

    /**
     * @notice Read notes without consuming them.
     * @param user    The inbox owner.
     * @param offset  Start position relative to the current head (0 = oldest).
     * @param limit   Maximum notes to return.
     * @return notes  Slice of notes starting at head+offset.
     */
    function peek(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (Note[] memory notes) {
        uint256 head    = _heads[user];
        uint256 total   = _inboxes[user].length;
        uint256 pending = total - head;

        if (offset >= pending || limit == 0) {
            return new Note[](0);
        }

        uint256 available = pending - offset;
        uint256 size      = available < limit ? available : limit;

        notes = new Note[](size);
        for (uint256 i = 0; i < size; i++) {
            notes[i] = _inboxes[user][head + offset + i];
        }
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _drain(
        address owner,
        uint256 limit
    ) internal returns (Note[] memory notes) {
        uint256 head    = _heads[owner];
        uint256 total   = _inboxes[owner].length;
        uint256 pending = total - head;

        if (pending == 0 || limit == 0) {
            return new Note[](0);
        }

        uint256 take = pending < limit ? pending : limit;
        notes = new Note[](take);

        for (uint256 i = 0; i < take; i++) {
            notes[i] = _inboxes[owner][head + i];
            // Zero the storage slot for a gas refund.
            delete _inboxes[owner][head + i];
        }

        _heads[owner] = head + take;

        emit NotesDrained(owner, take);
    }
}
