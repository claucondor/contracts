// reset-janus-ft.cdc — DEV ONLY. Wipes all commitments + totalLocked so the
// smoke can be re-run with a clean slate. Requires the deployer
// account's Admin resource at /storage/janusFTAdmin.

import JanusFT from 0xc4e8f99915893a2f

transaction {
    prepare(signer: auth(BorrowValue) &Account) {
        let admin = signer.storage.borrow<&JanusFT.Admin>(from: JanusFT.AdminStoragePath)
            ?? panic("Admin not found at /storage/janusFTAdmin")
        admin.resetTotalLockedForTestingOnly()
    }
}
