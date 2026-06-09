import ShieldedInbox from "../../contracts/cadence/ShieldedInbox.cdc"

/// Returns the number of pending notes in `user`'s inbox.
/// Returns 0 if the inbox is not installed.
access(all) fun main(user: Address): Int {
    let cap = getAccount(user)
        .capabilities
        .borrow<&{ShieldedInbox.Receiver}>(/public/shieldedInbox)
    if cap == nil {
        return 0
    }
    return cap!.count()
}
