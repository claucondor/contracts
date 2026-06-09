/// install_inbox_ft.cdc — Install ShieldedInbox for a JanusFT test account.
///
/// Idempotent: safe to call multiple times.  Referenced from JanusFT Cadence tests.
/// Mirrors the shielded-recovery install_inbox.cdc pattern.

import ShieldedInbox from "ShieldedInbox"

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, StorageCapabilities, PublishCapability) &Account) {
        if signer.storage.borrow<&ShieldedInbox.NoteInbox>(from: /storage/shieldedInbox) != nil {
            return
        }
        let inbox <- ShieldedInbox.createInbox(owner: signer.address)
        signer.storage.save(<-inbox, to: /storage/shieldedInbox)
        let receiverCap = signer.capabilities.storage
            .issue<&{ShieldedInbox.Receiver}>(/storage/shieldedInbox)
        signer.capabilities.publish(receiverCap, at: /public/shieldedInbox)
    }
}
