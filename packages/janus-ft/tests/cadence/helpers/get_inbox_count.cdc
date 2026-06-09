/// get_inbox_count.cdc — Script: return pending note count for a user's ShieldedInbox.

import ShieldedInbox from "ShieldedInbox"

access(all) fun main(user: Address): Int {
    let inbox = getAccount(user)
        .capabilities.borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
        ?? panic("get_inbox_count: user has no ShieldedInbox installed")
    return inbox.count()
}
