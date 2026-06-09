/// get_max_batch_reset.cdc — Return MAX_BATCH_RESET constant from JanusFT.

import JanusFT from "JanusFT"

access(all) fun main(): Int {
    return JanusFT.MAX_BATCH_RESET()
}
