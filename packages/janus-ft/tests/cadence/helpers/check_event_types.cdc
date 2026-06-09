/// check_event_types.cdc — Verify v0.8 event types exist on JanusFT contract.
/// Returns true if both ShieldedTransferNote and ShieldedTransferWithSnapshot
/// (deprecated) are accessible as types.

import JanusFT from "JanusFT"

access(all) fun main(): Bool {
    let noteType    = Type<JanusFT.ShieldedTransferNote>()
    let legacyType  = Type<JanusFT.ShieldedTransferWithSnapshot>()
    return noteType != legacyType
}
