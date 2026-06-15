import ShieldedInbox from "../../contracts/cadence/ShieldedInbox.cdc"

access(all) fun main(): Int {
    return ShieldedInbox.MAX_CIPHERTEXT_BYTES
}
