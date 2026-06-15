/// set_commitment.cdc — Test helper: write an arbitrary commitment for an account.
///
/// Calls Admin.setCommitmentForTestingOnly() to seed state without requiring a real
/// ZK proof or BabyJub cross-VM call.  Used by adminResetSlot / adminBatchResetSlots
/// unit tests to create the precondition (non-nil commitment slot).
///
/// MAINNET-PREPARE-REMOVE: this transaction and the Admin method it calls must be
/// removed before mainnet deployment.

import JanusFT from "JanusFT"

transaction(account: Address, x: UInt256, y: UInt256) {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFT.Admin>(
            from: JanusFT.AdminProofStoragePath
        ) ?? panic("set_commitment: caller is not the JanusFT admin")

        adminRef.setCommitmentForTestingOnly(account: account, x: x, y: y)
    }
}
