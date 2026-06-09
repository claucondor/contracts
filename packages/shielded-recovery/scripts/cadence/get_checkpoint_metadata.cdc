import ShieldedCheckpoint from "../../contracts/cadence/ShieldedCheckpoint.cdc"

/// Returns public metadata for `user`'s checkpoint.
///
/// Fields returned:
///   version               - Update counter (0 if no checkpoint exists).
///   lastConsumedNoteIndex - Cursor: inbox notes consumed into the checkpoint.
///   lastUpdatedBlock      - Block height at the time of the last update.
///   exists                - True if the user has called update() at least once.
///
/// Returns zero values for a user who has never installed / updated a checkpoint.
/// The encrypted snapshot is NOT returned — use owner-entitled access for that.
access(all) fun main(user: Address): {String: AnyStruct} {
    let cap = getAccount(user)
        .capabilities
        .borrow<&{ShieldedCheckpoint.Metadata}>(/public/shieldedCheckpoint)

    if cap == nil {
        return {
            "version":               UInt64(0),
            "lastConsumedNoteIndex": UInt64(0),
            "lastUpdatedBlock":      UInt64(0),
            "exists":                false
        }
    }

    let meta = cap!
    return {
        "version":               meta.getVersion(),
        "lastConsumedNoteIndex": meta.getLastConsumedNoteIndex(),
        "lastUpdatedBlock":      meta.getLastUpdatedBlock(),
        "exists":                meta.exists()
    }
}
