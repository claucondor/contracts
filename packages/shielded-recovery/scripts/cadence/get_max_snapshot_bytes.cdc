import ShieldedCheckpoint from "../../contracts/cadence/ShieldedCheckpoint.cdc"

/// Returns the MAX_SNAPSHOT_BYTES constant from ShieldedCheckpoint.
access(all) fun main(): Int {
    return ShieldedCheckpoint.MAX_SNAPSHOT_BYTES
}
