/// get_total_locked.cdc — Return JanusFT totalLocked value.

import JanusFT from "JanusFT"

access(all) fun main(): UFix64 {
    return JanusFT.getTotalLocked()
}
