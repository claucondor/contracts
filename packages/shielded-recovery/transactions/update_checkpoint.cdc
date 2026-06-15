/// update_checkpoint.cdc
///
/// Owner-only transaction: writes or overwrites the signer's ShieldedCheckpoint for a
/// specific token slot with a new encrypted snapshot and cursor position.
///
/// Parameters
/// ----------
/// token                - String key for the token slot (e.g. "0x" + 40-char EVM address
///                        lowercase, or "0x" + 16-char Cadence address).  No validation
///                        performed — plain string key.  Writing to one token slot does
///                        NOT affect any other token slot.
/// encryptedSnapshot    - Opaque encrypted state blob (max 16384 bytes).
///                        Empty bytes are valid — signals a cleared state.
/// ephPubkeyX           - X-coordinate of the ECIES ephemeral public key used to
///                        encrypt the snapshot.
/// ephPubkeyY           - Y-coordinate of the ECIES ephemeral public key.
/// lastConsumedNoteIndex - Cursor: how many ShieldedInbox notes have been consumed
///                         into this checkpoint.  Monotonicity is NOT enforced;
///                         callers may pass a lower value to trigger a rescan.
///
/// Panics if the checkpoint is not installed (run install_checkpoint.cdc first).
/// Panics if encryptedSnapshot exceeds MAX_SNAPSHOT_BYTES (16384 bytes).

import ShieldedCheckpoint from "../contracts/cadence/ShieldedCheckpoint.cdc"

transaction(
    token:                 String,
    encryptedSnapshot:     [UInt8],
    ephPubkeyX:            UInt256,
    ephPubkeyY:            UInt256,
    lastConsumedNoteIndex: UInt64
) {
    prepare(signer: auth(BorrowValue) &Account) {
        let cp = signer.storage.borrow<auth(ShieldedCheckpoint.Owner) &ShieldedCheckpoint.Checkpoint>(
            from: /storage/shieldedCheckpoint
        ) ?? panic("ShieldedCheckpoint: not installed — run install_checkpoint first")

        cp.update(
            token:                 token,
            encryptedSnapshot:     encryptedSnapshot,
            ephPubkeyX:            ephPubkeyX,
            ephPubkeyY:            ephPubkeyY,
            lastConsumedNoteIndex: lastConsumedNoteIndex
        )
    }
}
