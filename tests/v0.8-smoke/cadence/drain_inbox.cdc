/// drain_inbox.cdc — Drain all notes from signer's ShieldedInbox (returns them as events).

import "ShieldedInbox"

transaction {
    prepare(owner: auth(BorrowValue) &Account) {
        let inbox = owner.storage.borrow<auth(ShieldedInbox.Owner) &ShieldedInbox.NoteInbox>(
            from: /storage/shieldedInbox
        ) ?? panic("drain_inbox: no NoteInbox at /storage/shieldedInbox — run install_inbox first")
        let notes = inbox.drainAll()
        log("drain_inbox: drained ".concat(notes.length.toString()).concat(" notes"))
    }
}
