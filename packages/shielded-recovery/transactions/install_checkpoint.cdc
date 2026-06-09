/// install_checkpoint.cdc
///
/// Idempotent transaction: creates and saves a @ShieldedCheckpoint.Checkpoint resource
/// to the signer's storage, then publishes a public &{ShieldedCheckpoint.Metadata}
/// capability so that indexers and recovery tools can read non-sensitive metadata.
///
/// The encrypted snapshot itself is never exposed through the public capability.
/// Only the owner (via auth(Owner) borrow from their own storage) can read the blob
/// or write updates.
///
/// Safe to run multiple times: returns early if the checkpoint is already installed.

import ShieldedCheckpoint from "../contracts/cadence/ShieldedCheckpoint.cdc"

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, StorageCapabilities, PublishCapability) &Account) {

        // Idempotent guard — skip if already installed.
        if signer.storage.borrow<&ShieldedCheckpoint.Checkpoint>(
            from: /storage/shieldedCheckpoint
        ) != nil {
            return
        }

        // Create a fresh checkpoint owned by this account.
        let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
        signer.storage.save(<-cp, to: /storage/shieldedCheckpoint)

        // Publish a metadata-only public capability.
        // Callers borrowing &{ShieldedCheckpoint.Metadata} can read version,
        // lastConsumedNoteIndex, and lastUpdatedBlock — but NOT the encrypted blob.
        let metaCap = signer.capabilities.storage
            .issue<&{ShieldedCheckpoint.Metadata}>(/storage/shieldedCheckpoint)
        signer.capabilities.publish(metaCap, at: /public/shieldedCheckpoint)
    }
}
