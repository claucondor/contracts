/// ShieldedCheckpoint — per-user encrypted state checkpoint for the Janus protocol.
///
/// Semantics
/// ---------
/// - The checkpoint owner holds an auth(Owner) &Checkpoint reference for full read+write.
/// - Anyone can borrow a &{Metadata} capability at /public/shieldedCheckpoint to read
///   non-sensitive metadata (version, lastConsumedNoteIndex, lastUpdatedBlock).
/// - Content-agnostic: encryptedSnapshot is opaque [UInt8]. Applications define their
///   own payload schema on top.
/// - Stores cursor (lastConsumedNoteIndex) to track how many ShieldedInbox notes have
///   been consumed into this checkpoint, enabling resume on partial drains.
/// - Cursor monotonicity is NOT enforced — applications may rewind for rescans.
/// - Empty snapshot ([]) is valid — useful to signal a cleared or initialised state.
///
/// Resource model
/// --------------
/// Users call ShieldedCheckpoint.createCheckpoint(owner:) to obtain a @Checkpoint,
/// save it to /storage/shieldedCheckpoint, and publish a &{Metadata} capability at
/// /public/shieldedCheckpoint.  Only the resource owner (via auth(Owner) borrow from
/// their own storage) can call update() or read().
///
/// Design: immutable primitive — no contract upgradeability, no admin.

access(all) contract ShieldedCheckpoint {

    // -----------------------------------------------------------------------
    // Constants (set in init, immutable thereafter)
    // -----------------------------------------------------------------------

    /// 16 KB hard cap — double the ShieldedInbox note cap, allows richer state payloads.
    access(all) let MAX_SNAPSHOT_BYTES: Int

    // -----------------------------------------------------------------------
    // Entitlement
    // -----------------------------------------------------------------------

    access(all) entitlement Owner

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    access(all) event CheckpointUpdated(
        owner:                 Address,
        version:               UInt64,
        lastConsumedNoteIndex: UInt64,
        blockHeight:           UInt64
    )

    // -----------------------------------------------------------------------
    // CheckpointSnapshot struct — returned by read()
    // -----------------------------------------------------------------------

    /// Typed snapshot of all checkpoint fields.
    /// Returned by the Owner-entitled read() call so callers get a strongly-typed
    /// value rather than a raw {String: AnyStruct} dictionary.
    access(all) struct CheckpointSnapshot {
        access(all) let encryptedSnapshot:     [UInt8]
        access(all) let ephPubkeyX:            UInt256
        access(all) let ephPubkeyY:            UInt256
        access(all) let lastConsumedNoteIndex: UInt64
        access(all) let lastUpdatedBlock:      UInt64
        access(all) let version:               UInt64

        init(
            encryptedSnapshot:     [UInt8],
            ephPubkeyX:            UInt256,
            ephPubkeyY:            UInt256,
            lastConsumedNoteIndex: UInt64,
            lastUpdatedBlock:      UInt64,
            version:               UInt64
        ) {
            self.encryptedSnapshot     = encryptedSnapshot
            self.ephPubkeyX            = ephPubkeyX
            self.ephPubkeyY            = ephPubkeyY
            self.lastConsumedNoteIndex = lastConsumedNoteIndex
            self.lastUpdatedBlock      = lastUpdatedBlock
            self.version               = version
        }
    }

    // -----------------------------------------------------------------------
    // Metadata interface — public surface (no encrypted blob)
    // -----------------------------------------------------------------------

    /// Public capability type.  Exposes non-sensitive metadata; hides encrypted blob
    /// and owner-only write/read surface.
    access(all) resource interface Metadata {
        access(all) view fun getLastConsumedNoteIndex(): UInt64
        access(all) view fun getLastUpdatedBlock():      UInt64
        access(all) view fun getVersion():               UInt64
        /// Returns true once the owner has called update() at least once.
        access(all) view fun exists():                   Bool
    }

    // -----------------------------------------------------------------------
    // Checkpoint resource
    // -----------------------------------------------------------------------

    access(all) resource Checkpoint: Metadata {

        /// Opaque payload encrypted to the owner's pubkey.
        access(self) var encryptedSnapshot:     [UInt8]
        /// X-coordinate of the ECIES ephemeral public key used to encrypt the snapshot.
        access(self) var ephPubkeyX:            UInt256
        /// Y-coordinate of the ECIES ephemeral public key.
        access(self) var ephPubkeyY:            UInt256
        /// Cursor: how many ShieldedInbox notes have been consumed into this checkpoint.
        access(self) var lastConsumedNoteIndex: UInt64
        /// Block height at the time of the last update.
        access(self) var lastUpdatedBlock:      UInt64
        /// Monotonically increasing update counter.  Starts at 0 (no data); first update sets it to 1.
        access(self) var version:               UInt64
        /// Owner address — stored at creation for event emission.
        /// Named ownerAddr to avoid collision with the Cadence built-in `owner` resource property.
        access(self) let ownerAddr:             Address

        init(ownerAddr: Address) {
            self.encryptedSnapshot     = []
            self.ephPubkeyX            = 0
            self.ephPubkeyY            = 0
            self.lastConsumedNoteIndex = 0
            self.lastUpdatedBlock      = 0
            self.version               = 0
            self.ownerAddr             = ownerAddr
        }

        // ------------------------------------------------------------------
        // Metadata interface (public)
        // ------------------------------------------------------------------

        access(all) view fun getLastConsumedNoteIndex(): UInt64 {
            return self.lastConsumedNoteIndex
        }

        access(all) view fun getLastUpdatedBlock(): UInt64 {
            return self.lastUpdatedBlock
        }

        access(all) view fun getVersion(): UInt64 {
            return self.version
        }

        /// True once the owner has called update() at least once.
        access(all) view fun exists(): Bool {
            return self.version > 0
        }

        // ------------------------------------------------------------------
        // Owner-only write
        // ------------------------------------------------------------------

        /**
         * Create or overwrite this checkpoint.
         *
         * Validates that encryptedSnapshot does not exceed MAX_SNAPSHOT_BYTES.
         * Increments version on every call.
         * Cursor monotonicity is NOT enforced — apps may rewind for rescans.
         * Empty encryptedSnapshot is accepted.
         */
        access(Owner) fun update(
            encryptedSnapshot:     [UInt8],
            ephPubkeyX:            UInt256,
            ephPubkeyY:            UInt256,
            lastConsumedNoteIndex: UInt64
        ) {
            if encryptedSnapshot.length > ShieldedCheckpoint.MAX_SNAPSHOT_BYTES {
                panic("ShieldedCheckpoint: snapshot too large")
            }

            let newVersion  = self.version + 1
            let blockHeight = getCurrentBlock().height

            self.encryptedSnapshot     = encryptedSnapshot
            self.ephPubkeyX            = ephPubkeyX
            self.ephPubkeyY            = ephPubkeyY
            self.lastConsumedNoteIndex = lastConsumedNoteIndex
            self.lastUpdatedBlock      = blockHeight
            self.version               = newVersion

            emit ShieldedCheckpoint.CheckpointUpdated(
                owner:                 self.ownerAddr,
                version:               newVersion,
                lastConsumedNoteIndex: lastConsumedNoteIndex,
                blockHeight:           blockHeight
            )
        }

        // ------------------------------------------------------------------
        // Owner-only read
        // ------------------------------------------------------------------

        /**
         * Read the full checkpoint including the encrypted snapshot.
         *
         * Scoped to Owner entitlement by design: the encrypted blob should not be
         * readable via a public capability even though it is encrypted, to prevent
         * correlation attacks.
         *
         * Non-view: struct construction (CheckpointSnapshot init) is impure in
         * Cadence view context (initializers assign to self).  There are no side
         * effects on stored state; the non-view designation is a type-system artifact.
         *
         * Panics if no update() has been called yet (version == 0).
         */
        access(Owner) fun read(): ShieldedCheckpoint.CheckpointSnapshot {
            if self.version == 0 {
                panic("ShieldedCheckpoint: no checkpoint data — call update() first")
            }
            return ShieldedCheckpoint.CheckpointSnapshot(
                encryptedSnapshot:     self.encryptedSnapshot,
                ephPubkeyX:            self.ephPubkeyX,
                ephPubkeyY:            self.ephPubkeyY,
                lastConsumedNoteIndex: self.lastConsumedNoteIndex,
                lastUpdatedBlock:      self.lastUpdatedBlock,
                version:               self.version
            )
        }
    }

    // -----------------------------------------------------------------------
    // Factory
    // -----------------------------------------------------------------------

    /// Create a fresh Checkpoint resource for `owner`.
    /// The caller should save it to /storage/shieldedCheckpoint and publish a
    /// &{Metadata} capability at /public/shieldedCheckpoint.
    access(all) fun createCheckpoint(owner: Address): @Checkpoint {
        return <- create Checkpoint(ownerAddr: owner)
    }

    // -----------------------------------------------------------------------
    // Contract init
    // -----------------------------------------------------------------------

    init() {
        self.MAX_SNAPSHOT_BYTES = 16384
    }
}
