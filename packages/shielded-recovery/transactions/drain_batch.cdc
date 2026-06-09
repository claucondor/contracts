import ShieldedInbox from "../contracts/cadence/ShieldedInbox.cdc"

/// Drain up to `limit` oldest notes from the signer's inbox.
/// No-op (no panic) if the inbox is empty or limit == 0.
transaction(limit: Int) {
    prepare(owner: auth(Storage) &Account) {
        let inbox = owner.storage
            .borrow<auth(ShieldedInbox.Owner) &ShieldedInbox.NoteInbox>(
                from: /storage/shieldedInbox
            ) ?? panic("ShieldedInbox: inbox not installed")

        // Return value is discarded — side effect (head advance + event) is the goal.
        let _ = inbox.drainBatch(limit: limit)
    }
}
