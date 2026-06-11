/// read_checkpoint_owner.cdc — TEST-ONLY helper script.
///
/// Uses getAuthAccount (available only in test context) to borrow the caller's
/// Checkpoint resource with Owner entitlement and call read(token:).
///
/// Returns the CheckpointData for the given token slot.
/// Panics if the checkpoint is not installed or if no data exists for the token.
///
/// This script intentionally lives in test/cadence/helpers/ and must NOT be
/// deployed or used outside of flow test contexts.

import "ShieldedCheckpoint"

access(all) fun main(user: Address, token: String): ShieldedCheckpoint.CheckpointData {
    let account = getAuthAccount<auth(BorrowValue) &Account>(user)
    let cp = account.storage.borrow<auth(ShieldedCheckpoint.Owner) &ShieldedCheckpoint.Checkpoint>(
        from: /storage/shieldedCheckpoint
    ) ?? panic("ShieldedCheckpoint: not installed — run install_checkpoint first")
    return cp.read(token: token) ?? panic("ShieldedCheckpoint: no data for token — call update() first")
}
