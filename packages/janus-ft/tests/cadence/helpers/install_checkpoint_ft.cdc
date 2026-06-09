/// install_checkpoint_ft.cdc — Install ShieldedCheckpoint for a JanusFT test account.
///
/// Idempotent: safe to call multiple times.  Referenced from JanusFT Cadence tests.
/// Mirrors the shielded-recovery install_checkpoint.cdc pattern.

import ShieldedCheckpoint from "ShieldedCheckpoint"

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, StorageCapabilities, PublishCapability) &Account) {
        if signer.storage.borrow<&ShieldedCheckpoint.Checkpoint>(
            from: /storage/shieldedCheckpoint
        ) != nil {
            return
        }
        let cp <- ShieldedCheckpoint.createCheckpoint(owner: signer.address)
        signer.storage.save(<-cp, to: /storage/shieldedCheckpoint)
        let metaCap = signer.capabilities.storage
            .issue<&{ShieldedCheckpoint.Metadata}>(/storage/shieldedCheckpoint)
        signer.capabilities.publish(metaCap, at: /public/shieldedCheckpoint)
    }
}
