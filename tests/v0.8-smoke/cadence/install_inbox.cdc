/// install_inbox.cdc — Install ShieldedInbox NoteInbox (idempotent).
/// Any user runs this before receiving shielded transfers.

import "ShieldedInbox"

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, IssueStorageCapabilityController, PublishCapability) &Account) {
        if signer.storage.borrow<&ShieldedInbox.NoteInbox>(from: /storage/shieldedInbox) != nil {
            log("install_inbox: inbox already installed — skipping")
            return
        }
        let inbox <- ShieldedInbox.createInbox(owner: signer.address)
        signer.storage.save(<-inbox, to: /storage/shieldedInbox)

        let receiverCap = signer.capabilities.storage
            .issue<&{ShieldedInbox.Receiver}>(/storage/shieldedInbox)
        signer.capabilities.publish(receiverCap, at: /public/shieldedInbox)
        log("install_inbox: NoteInbox installed and Receiver capability published")
    }
}
