/// ShieldedInbox — per-user on-chain mailbox for receiving shielded notes.
///
/// Semantics
/// ---------
/// - Anyone can deposit a note ciphertext + ephemeral public key to any user's
///   published Receiver capability.
/// - Only the inbox owner (holding an `auth(Owner) &NoteInbox` reference) can drain.
/// - Notes are returned FIFO.  A head pointer advances on drain; the backing
///   array is never shifted.
/// - Content-agnostic: ciphertext is opaque [UInt8].  Applications define
///   their own payload schema on top.
///
/// Resource model
/// --------------
/// Users call `ShieldedInbox.createInbox(owner:)` to obtain a @NoteInbox resource,
/// save it to /storage/shieldedInbox, and publish a &{Receiver} capability at
/// /public/shieldedInbox.  Depositors borrow the public Receiver cap and call
/// `deposit(...)` directly on it.  Only the resource owner can call drainBatch /
/// drainAll via an auth(Owner) reference.
///
/// Note: the resource is named NoteInbox (not Inbox) to avoid collision with the
/// Cadence built-in Account.Inbox capability-delivery API.
///
/// Design: immutable primitive — no contract upgradeability, no admin.

access(all) contract ShieldedInbox {

    // -----------------------------------------------------------------------
    // Constants (set in init, immutable thereafter)
    // -----------------------------------------------------------------------

    access(all) let MAX_CIPHERTEXT_BYTES: Int  // 8 KB hard cap per note
    access(all) let MAX_INBOX_NOTES: Int        // overflow protection

    // -----------------------------------------------------------------------
    // Entitlement
    // -----------------------------------------------------------------------

    access(all) entitlement Owner

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    access(all) event NoteDeposited(recipient: Address, depositor: Address, index: Int)
    access(all) event NotesDrained(owner: Address, count: Int)

    // -----------------------------------------------------------------------
    // Note struct
    // -----------------------------------------------------------------------

    access(all) struct Note {
        access(all) let ciphertext:  [UInt8]
        access(all) let ephPubkeyX:  UInt256
        access(all) let ephPubkeyY:  UInt256
        access(all) let depositor:   Address
        access(all) let blockHeight: UInt64

        init(
            ciphertext:  [UInt8],
            ephPubkeyX:  UInt256,
            ephPubkeyY:  UInt256,
            depositor:   Address,
            blockHeight: UInt64
        ) {
            self.ciphertext  = ciphertext
            self.ephPubkeyX  = ephPubkeyX
            self.ephPubkeyY  = ephPubkeyY
            self.depositor   = depositor
            self.blockHeight = blockHeight
        }
    }

    // -----------------------------------------------------------------------
    // Receiver interface — append-only public surface
    // -----------------------------------------------------------------------

    /// Public capability type.  Exposes read + deposit; hides drain.
    /// Note: peek is non-view because building the result array requires
    /// local mutation (array.append), even though no stored state is modified.
    access(all) resource interface Receiver {
        access(all) view fun count(): Int
        access(all) fun peek(offset: Int, limit: Int): [Note]
        access(all) fun deposit(
            ciphertext:  [UInt8],
            ephPubkeyX:  UInt256,
            ephPubkeyY:  UInt256,
            depositor:   Address
        )
    }

    // -----------------------------------------------------------------------
    // NoteInbox resource
    // -----------------------------------------------------------------------

    access(all) resource NoteInbox: Receiver {

        /// Append-only backing store.  Consumed slots remain (head advances).
        access(self) var notes: [Note]

        /// Index of next unread note (FIFO head pointer).
        access(self) var head: Int

        /// Owner address — stored at creation for event emission.
        /// Named `ownerAddr` to avoid collision with the Cadence built-in
        /// `owner` resource property.
        access(self) let ownerAddr: Address

        init(ownerAddr: Address) {
            self.notes     = []
            self.head      = 0
            self.ownerAddr = ownerAddr
        }

        // ------------------------------------------------------------------
        // Receiver — public surface
        // ------------------------------------------------------------------

        /// Number of pending (unread) notes.
        access(all) view fun count(): Int {
            return self.notes.length - self.head
        }

        /// Non-consuming read starting at head+offset, returning up to limit notes.
        /// Non-view because local array construction requires append (impure in Cadence
        /// view context), though no stored state is modified.
        access(all) fun peek(offset: Int, limit: Int): [Note] {
            let pending = self.notes.length - self.head
            if offset >= pending || limit <= 0 {
                return []
            }
            let available = pending - offset
            let size = available < limit ? available : limit
            var result: [Note] = []
            var i = 0
            while i < size {
                result.append(self.notes[self.head + offset + i])
                i = i + 1
            }
            return result
        }

        /// Append a note.  Panics if ciphertext exceeds MAX_CIPHERTEXT_BYTES
        /// or the inbox already holds MAX_INBOX_NOTES pending notes.
        access(all) fun deposit(
            ciphertext:  [UInt8],
            ephPubkeyX:  UInt256,
            ephPubkeyY:  UInt256,
            depositor:   Address
        ) {
            if ciphertext.length > ShieldedInbox.MAX_CIPHERTEXT_BYTES {
                panic("ShieldedInbox: ciphertext too large")
            }
            let pending = self.notes.length - self.head
            if pending >= ShieldedInbox.MAX_INBOX_NOTES {
                panic("ShieldedInbox: inbox full")
            }

            let idx = self.notes.length
            let note = Note(
                ciphertext:  ciphertext,
                ephPubkeyX:  ephPubkeyX,
                ephPubkeyY:  ephPubkeyY,
                depositor:   depositor,
                blockHeight: getCurrentBlock().height
            )
            self.notes.append(note)

            emit NoteDeposited(
                recipient: self.ownerAddr,
                depositor: depositor,
                index:     idx
            )
        }

        // ------------------------------------------------------------------
        // Owner-only surface (requires auth(Owner) reference)
        // ------------------------------------------------------------------

        /// Drain up to `limit` oldest notes.  Returns empty array if inbox is
        /// empty or limit <= 0.
        access(Owner) fun drainBatch(limit: Int): [Note] {
            return self.drainNotes(limit: limit)
        }

        /// Drain all pending notes.
        access(Owner) fun drainAll(): [Note] {
            let pending = self.notes.length - self.head
            return self.drainNotes(limit: pending)
        }

        // ------------------------------------------------------------------
        // Private helper
        // ------------------------------------------------------------------

        access(self) fun drainNotes(limit: Int): [Note] {
            let pending = self.notes.length - self.head
            if pending == 0 || limit <= 0 {
                return []
            }
            let take = pending < limit ? pending : limit
            var result: [Note] = []
            var i = 0
            while i < take {
                result.append(self.notes[self.head + i])
                i = i + 1
            }
            self.head = self.head + take

            emit NotesDrained(owner: self.ownerAddr, count: take)
            return result
        }
    }

    // -----------------------------------------------------------------------
    // Factory
    // -----------------------------------------------------------------------

    /// Create a fresh NoteInbox resource for `owner`.
    /// The caller should save it to /storage/shieldedInbox and publish a
    /// &{Receiver} capability at /public/shieldedInbox.
    access(all) fun createInbox(owner: Address): @NoteInbox {
        return <- create NoteInbox(ownerAddr: owner)
    }

    // -----------------------------------------------------------------------
    // Contract init
    // -----------------------------------------------------------------------

    init() {
        self.MAX_CIPHERTEXT_BYTES = 8192
        self.MAX_INBOX_NOTES      = 10000
    }
}
