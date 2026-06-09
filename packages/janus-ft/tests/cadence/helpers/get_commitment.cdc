/// get_commitment.cdc — Script: read commitment coords for an account.
///
/// Returns {String: UInt256} with keys "x" and "y".
/// Returns identity (x=0, y=1) if the account has no commitment.

import JanusFT from "JanusFT"

access(all) fun main(account: Address): {String: UInt256} {
    let c = JanusFT.balanceOfCommitment(account: account)
    return { "x": c.x, "y": c.y }
}
