import ShieldedInbox from "../contracts/cadence/ShieldedInbox.cdc"

/// Drain all pending notes from the signer's inbox.
/// No-op (no panic) if the inbox is empty.
transaction {
    prepare(owner: auth(Storage) &Account) {
        let inbox = owner.storage
            .borrow<auth(ShieldedInbox.Owner) &ShieldedInbox.NoteInbox>(
                from: /storage/shieldedInbox
            ) ?? panic("ShieldedInbox: inbox not installed")

        let _ = inbox.drainAll()
    }
}
