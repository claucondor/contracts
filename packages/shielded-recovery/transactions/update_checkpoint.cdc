/// update_checkpoint.cdc
///
/// Owner-only transaction: overwrites the signer's ShieldedCheckpoint with a new
/// encrypted snapshot and cursor position.
///
/// Parameters
/// ----------
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
            encryptedSnapshot:     encryptedSnapshot,
            ephPubkeyX:            ephPubkeyX,
            ephPubkeyY:            ephPubkeyY,
            lastConsumedNoteIndex: lastConsumedNoteIndex
        )
    }
}
