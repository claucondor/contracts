/// install_checkpoint.cdc
///
/// Idempotent transaction: creates and saves a @ShieldedCheckpoint.Checkpoint resource
/// to the signer's storage, then publishes a public &{ShieldedCheckpoint.Metadata}
/// capability so that indexers and recovery tools can read non-sensitive metadata.
///
/// Migration-safe: if the path holds a stale resource from a previous deploy
/// (different contract address → different type identifier), the load+destroy
/// step clears it before saving the fresh checkpoint. This unblocks users who
/// installed against the old singleton contract at 0x4b6bc58bc8bf5dcc.
///
/// The encrypted snapshot itself is never exposed through the public capability.
/// Only the owner can read the blob or write updates.

import ShieldedCheckpoint from "../contracts/cadence/ShieldedCheckpoint.cdc"

transaction {
    prepare(
        signer: auth(
            BorrowValue,
            SaveValue,
            LoadValue,
            IssueStorageCapabilityController,
            PublishCapability,
            UnpublishCapability
        ) &Account
    ) {
        let storagePath = /storage/shieldedCheckpoint
        let publicPath  = /public/shieldedCheckpoint

        let storedType = signer.storage.type(at: storagePath)

        // Already installed as the CURRENT contract type → just re-publish capability.
        if storedType == Type<@ShieldedCheckpoint.Checkpoint>() {
            signer.capabilities.unpublish(publicPath)
            let cap = signer.capabilities.storage.issue<&{ShieldedCheckpoint.Metadata}>(storagePath)
            signer.capabilities.publish(cap, at: publicPath)
            return
        }

        // Migration: a stale resource (different contract type) sits at the path.
        // Load as AnyResource (won't match concrete type) and destroy.
        if storedType != nil {
            let stale <- signer.storage.load<@AnyResource>(from: storagePath)
                ?? panic("install_checkpoint: stale resource vanished")
            destroy stale
        }

        // Create + save fresh checkpoint resource (NEW contract type).
        let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
        signer.storage.save(<- cp, to: storagePath)

        // Re-publish metadata capability.
        signer.capabilities.unpublish(publicPath)
        let cap = signer.capabilities.storage.issue<&{ShieldedCheckpoint.Metadata}>(storagePath)
        signer.capabilities.publish(cap, at: publicPath)
    }
}
