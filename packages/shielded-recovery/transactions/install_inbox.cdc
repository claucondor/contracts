/// install_inbox.cdc
///
/// Idempotent transaction: creates and saves an @ShieldedInbox.Inbox resource to
/// the signer's storage, then publishes a public &{ShieldedInbox.Receiver}
/// capability so that anyone can deposit notes.
///
/// Safe to run multiple times: returns early if the inbox is already installed.

import ShieldedInbox from "../contracts/cadence/ShieldedInbox.cdc"

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, StorageCapabilities, PublishCapability) &Account) {

        // Idempotent guard — skip if already installed.
        if signer.storage.borrow<&ShieldedInbox.NoteInbox>(from: /storage/shieldedInbox) != nil {
            return
        }

        // Create a fresh inbox owned by this account.
        let inbox <- ShieldedInbox.createInbox(owner: signer.address)
        signer.storage.save(<-inbox, to: /storage/shieldedInbox)

        // Publish an append-only public capability so depositors can reach this inbox.
        let receiverCap = signer.capabilities.storage
            .issue<&{ShieldedInbox.Receiver}>(/storage/shieldedInbox)
        signer.capabilities.publish(receiverCap, at: /public/shieldedInbox)
    }
}
