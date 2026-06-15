import ShieldedInbox from "../../contracts/cadence/ShieldedInbox.cdc"

/// Non-consuming read of up to `limit` notes starting at `offset` from
/// the head of `user`'s inbox.  Returns empty array if not installed.
access(all) fun main(user: Address, offset: Int, limit: Int): [ShieldedInbox.Note] {
    let cap = getAccount(user)
        .capabilities
        .borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
    if cap == nil {
        return []
    }
    return cap!.peek(offset: offset, limit: limit)
}
