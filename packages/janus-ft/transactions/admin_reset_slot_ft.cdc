// admin_reset_slot_ft.cdc — Admin: reset a single user's JanusFT commitment slot.
//
// Clears the user's on-chain commitment back to nil (identity sentinel).
// The next call to JanusFT.balanceOfCommitment(user) will return Commitment(x:0, y:1).
//
// Use cases:
//   - Emergency recovery: user's slot is in an inconsistent state due to a protocol bug.
//   - Mainnet preparation: clearing test artifacts from testnet.
//   - Regulatory compliance: clearing a slot upon legal order (paired with OFAC screening).
//
// Panics if the user has no existing slot (pre-condition guard to prevent silent no-ops).
// Emits JanusFT.SlotReset(user: user) for off-chain audit trail.
//
// Signer must hold the JanusFT Admin resource at JanusFT.AdminProofStoragePath.
// Only the contract deployer has this resource.
//
// Args:
//   user    Address whose slot to clear

import "JanusFT"

transaction(user: Address) {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFT.Admin>(
            from: JanusFT.AdminProofStoragePath
        ) ?? panic("admin_reset_slot_ft: caller is not the JanusFT admin")

        adminRef.adminResetSlot(user: user)
    }
}
