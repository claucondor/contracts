/// admin_reset_janusFT.cdc — Batch-reset JanusFT commitment slots via the Admin resource.
/// Signer must hold the JanusFT Admin resource at /storage/janusFTAdmin.

import "JanusFT"

transaction(users: [Address]) {
    let admin: &JanusFT.Admin

    prepare(signer: auth(BorrowValue) &Account) {
        self.admin = signer.storage.borrow<&JanusFT.Admin>(
            from: JanusFT.AdminStoragePath
        ) ?? panic("admin_reset_janusFT: signer does not hold JanusFT.Admin")
    }

    execute {
        self.admin.adminBatchResetSlots(users: users)
        log("admin_reset_janusFT: reset ".concat(users.length.toString()).concat(" slots"))
    }
}
