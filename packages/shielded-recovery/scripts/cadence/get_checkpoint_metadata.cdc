import ShieldedCheckpoint from "../../contracts/cadence/ShieldedCheckpoint.cdc"

/// Returns public metadata for `user`'s checkpoint at the given token slot.
///
/// Parameters
/// ----------
/// user  - The account whose checkpoint to query.
/// token - The token slot key (e.g. "0x" + 40-char EVM address lowercase).
///
/// Fields returned:
///   version               - Update counter for this token slot (0 if never updated).
///   lastConsumedNoteIndex - Cursor: inbox notes consumed into this token's checkpoint.
///   lastUpdatedBlock      - Block height at the time of the last update (0 if none).
///   exists                - True if update() has been called at least once for this token.
///
/// Returns zero values for a user who has never installed / updated a checkpoint,
/// or for a token slot that has never been written.
/// The encrypted snapshot is NOT returned — use owner-entitled access for that.
access(all) fun main(user: Address, token: String): {String: AnyStruct} {
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

    let meta = cap!.metadata(token: token)
    return {
        "version":               meta.version,
        "lastConsumedNoteIndex": meta.lastConsumedNoteIndex,
        "lastUpdatedBlock":      meta.lastUpdatedBlock,
        "exists":                meta.hasCheckpoint
    }
}
