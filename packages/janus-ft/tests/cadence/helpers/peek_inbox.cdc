/// peek_inbox.cdc — Script: non-consuming read of ShieldedInbox notes.

import ShieldedInbox from "ShieldedInbox"

access(all) fun main(user: Address, offset: Int, limit: Int): [ShieldedInbox.Note] {
    let inbox = getAccount(user)
        .capabilities.borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
        ?? panic("peek_inbox: user has no ShieldedInbox installed")
    return inbox.peek(offset: offset, limit: limit)
}
