/// check_admin_proof_path.cdc — Verify AdminProofStoragePath equals AdminStoragePath.

import JanusFT from "JanusFT"

access(all) fun main(): Bool {
    return JanusFT.AdminProofStoragePath == JanusFT.AdminStoragePath
}
