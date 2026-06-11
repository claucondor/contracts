/// ShieldedCheckpoint — per-user, per-token encrypted state checkpoint for the Janus protocol.
///
/// Semantics
/// ---------
/// - The checkpoint owner holds an auth(Owner) &Checkpoint reference for full read+write.
/// - Anyone can borrow a &{Metadata} capability at /public/shieldedCheckpoint to read
///   non-sensitive per-token metadata (version, lastConsumedNoteIndex, lastUpdatedBlock).
/// - Content-agnostic: encryptedSnapshot is opaque [UInt8]. Applications define their
///   own payload schema on top.
/// - Stores cursor (lastConsumedNoteIndex) to track how many ShieldedInbox notes have
///   been consumed into this checkpoint, enabling resume on partial drains.
/// - Cursor monotonicity is NOT enforced — applications may rewind for rescans.
/// - Empty snapshot ([]) is valid — useful to signal a cleared or initialised state.
///
/// Per-token model
/// ---------------
/// Each (user, token) pair is an independent slot inside the Checkpoint resource.
/// The token key is a String, typically "0x" + 40 hex chars (lowercase) for EVM tokens,
/// or "0x" + 16 hex chars for Cadence addresses. No validation is performed on the key.
/// Writing to one token slot does NOT affect any other token slot.
/// Calling read(token:) for an unwritten slot returns nil instead of panicking.
///
/// Resource model
/// --------------
/// Users call ShieldedCheckpoint.createCheckpoint(owner:) to obtain a @Checkpoint,
/// save it to /storage/shieldedCheckpoint, and publish a &{Metadata} capability at
/// /public/shieldedCheckpoint.  Only the resource owner (via auth(Owner) borrow from
/// their own storage) can call update() or read().
///
/// Upgrade safety
/// --------------
/// No new contract-level fields are added. All per-token state lives inside the
/// Checkpoint resource (inside a {String: TokenSlot} dictionary). This is safe
/// under the Cadence upgrade validator ("no new top-level fields" rule).
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
        token:                 String,
        version:               UInt64,
        lastConsumedNoteIndex: UInt64,
        blockHeight:           UInt64
    )

    // -----------------------------------------------------------------------
    // TokenSlot struct — internal per-token storage unit
    // -----------------------------------------------------------------------

    /// Internal struct representing a single (user, token) checkpoint slot.
    /// Lives inside the Checkpoint resource's slots dictionary.
    /// All fields are immutable — a new TokenSlot is created on every update.
    access(all) struct TokenSlot {
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
    // CheckpointData struct — returned by read() (includes encrypted blob)
    // -----------------------------------------------------------------------

    /// Typed snapshot of all checkpoint fields for a given token slot.
    /// Returned by the Owner-entitled read() call so callers get a strongly-typed
    /// value rather than a raw {String: AnyStruct} dictionary.
    access(all) struct CheckpointData {
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
    // CheckpointMetadata struct — returned by metadata() (no encrypted blob)
    // -----------------------------------------------------------------------

    /// Public-safe metadata for a given (user, token) slot.
    /// Does NOT include the encrypted snapshot — safe for indexers and recovery UI.
    access(all) struct CheckpointMetadata {
        access(all) let lastConsumedNoteIndex: UInt64
        access(all) let lastUpdatedBlock:      UInt64
        access(all) let version:               UInt64
        /// True once update() has been called at least once for this token slot.
        access(all) let hasCheckpoint:         Bool

        init(
            lastConsumedNoteIndex: UInt64,
            lastUpdatedBlock:      UInt64,
            version:               UInt64,
            hasCheckpoint:         Bool
        ) {
            self.lastConsumedNoteIndex = lastConsumedNoteIndex
            self.lastUpdatedBlock      = lastUpdatedBlock
            self.version               = version
            self.hasCheckpoint         = hasCheckpoint
        }
    }

    // -----------------------------------------------------------------------
    // Metadata interface — public surface (no encrypted blob, per-token)
    // -----------------------------------------------------------------------

    /// Public capability type.  Exposes non-sensitive per-token metadata.
    /// Hides encrypted blob and owner-only write/read surface.
    access(all) resource interface Metadata {
        /// Returns public metadata for the given token slot.
        /// Returns zero-value metadata (version=0, hasCheckpoint=false) for unwritten slots.
        access(all) fun metadata(token: String): ShieldedCheckpoint.CheckpointMetadata
        /// Returns true if update() has been called at least once for this token slot.
        access(all) view fun tokenSlotExists(token: String): Bool
    }

    // -----------------------------------------------------------------------
    // Checkpoint resource
    // -----------------------------------------------------------------------

    access(all) resource Checkpoint: Metadata {

        /// Per-token slots: String key → TokenSlot value.
        /// Key is typically "0x" + 40 hex chars (lowercase) for EVM tokens,
        /// or "0x" + 16 hex chars for Cadence addresses. No validation performed.
        access(self) var slots:     {String: ShieldedCheckpoint.TokenSlot}

        /// Owner address — stored at creation for event emission.
        /// Named ownerAddr to avoid collision with the Cadence built-in `owner` resource property.
        access(self) let ownerAddr: Address

        init(ownerAddr: Address) {
            self.slots     = {}
            self.ownerAddr = ownerAddr
        }

        // ------------------------------------------------------------------
        // Metadata interface (public, per-token)
        // ------------------------------------------------------------------

        /// Returns public metadata for the given token slot.
        /// Returns zero-value metadata for unwritten or non-existent slots.
        access(all) fun metadata(token: String): ShieldedCheckpoint.CheckpointMetadata {
            if let slot = self.slots[token] {
                return ShieldedCheckpoint.CheckpointMetadata(
                    lastConsumedNoteIndex: slot.lastConsumedNoteIndex,
                    lastUpdatedBlock:      slot.lastUpdatedBlock,
                    version:              slot.version,
                    hasCheckpoint:         slot.version > 0
                )
            }
            return ShieldedCheckpoint.CheckpointMetadata(
                lastConsumedNoteIndex: 0,
                lastUpdatedBlock:      0,
                version:               0,
                hasCheckpoint:         false
            )
        }

        /// Returns true if update() has been called at least once for this token slot.
        access(all) view fun tokenSlotExists(token: String): Bool {
            if let slot = self.slots[token] {
                return slot.version > 0
            }
            return false
        }

        // ------------------------------------------------------------------
        // Owner-only write
        // ------------------------------------------------------------------

        /**
         * Create or overwrite the checkpoint for a specific token slot.
         *
         * token                 - String key for the token (e.g. "0x" + 40-char EVM address
         *                         lowercase, or "0x" + 16-char Cadence address).  No
         *                         validation performed — treated as a plain dict key.
         *                         Zero-length string and any other string are permitted.
         * encryptedSnapshot     - Opaque encrypted state blob (max MAX_SNAPSHOT_BYTES).
         *                         Empty bytes are valid — useful to signal a cleared state.
         * ephPubkeyX            - X-coordinate of the ECIES ephemeral public key used to
         *                         encrypt the snapshot.
         * ephPubkeyY            - Y-coordinate of the ECIES ephemeral public key.
         * lastConsumedNoteIndex - Cursor: how many ShieldedInbox notes have been consumed
         *                         into this checkpoint.  Monotonicity is NOT enforced;
         *                         callers may rewind for rescans.
         *
         * Writing to one token slot does NOT affect any other token slot.
         * Version is per-token-slot and increments independently.
         */
        access(Owner) fun update(
            token:                 String,
            encryptedSnapshot:     [UInt8],
            ephPubkeyX:            UInt256,
            ephPubkeyY:            UInt256,
            lastConsumedNoteIndex: UInt64
        ) {
            if encryptedSnapshot.length > ShieldedCheckpoint.MAX_SNAPSHOT_BYTES {
                panic("ShieldedCheckpoint: snapshot too large")
            }

            let blockHeight:      UInt64 = getCurrentBlock().height
            let currentVersion:   UInt64 = self.slots[token]?.version ?? 0
            let newVersion:       UInt64 = currentVersion + 1

            self.slots[token] = ShieldedCheckpoint.TokenSlot(
                encryptedSnapshot:     encryptedSnapshot,
                ephPubkeyX:            ephPubkeyX,
                ephPubkeyY:            ephPubkeyY,
                lastConsumedNoteIndex: lastConsumedNoteIndex,
                lastUpdatedBlock:      blockHeight,
                version:               newVersion
            )

            emit ShieldedCheckpoint.CheckpointUpdated(
                owner:                 self.ownerAddr,
                token:                 token,
                version:               newVersion,
                lastConsumedNoteIndex: lastConsumedNoteIndex,
                blockHeight:           blockHeight
            )
        }

        // ------------------------------------------------------------------
        // Owner-only read
        // ------------------------------------------------------------------

        /**
         * Read the full checkpoint for a specific token slot including the encrypted blob.
         *
         * Returns nil if update() has never been called for this token slot.
         *
         * Scoped to Owner entitlement by design: the encrypted blob should not be
         * readable via a public capability even though it is encrypted, to prevent
         * correlation attacks.
         *
         * Non-view: struct construction in Cadence view context can conflict with
         * [UInt8] array initialization in some Cadence versions; no side effects
         * on stored state.
         */
        access(Owner) fun read(token: String): ShieldedCheckpoint.CheckpointData? {
            if let slot = self.slots[token] {
                if slot.version == 0 {
                    return nil
                }
                return ShieldedCheckpoint.CheckpointData(
                    encryptedSnapshot:     slot.encryptedSnapshot,
                    ephPubkeyX:            slot.ephPubkeyX,
                    ephPubkeyY:            slot.ephPubkeyY,
                    lastConsumedNoteIndex: slot.lastConsumedNoteIndex,
                    lastUpdatedBlock:      slot.lastUpdatedBlock,
                    version:               slot.version
                )
            }
            return nil
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
