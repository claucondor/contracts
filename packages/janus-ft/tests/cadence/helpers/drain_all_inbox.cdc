/// drain_all_inbox.cdc — Test helper: owner drains all notes from their ShieldedInbox.

import ShieldedInbox from "ShieldedInbox"

transaction {
    prepare(owner: auth(BorrowValue) &Account) {
        let inbox = owner.storage.borrow<auth(ShieldedInbox.Owner) &ShieldedInbox.NoteInbox>(
            from: /storage/shieldedInbox
        ) ?? panic("drain_all_inbox: no NoteInbox at /storage/shieldedInbox")
        let _ = inbox.drainAll()
    }
}
