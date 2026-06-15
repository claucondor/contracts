// admin_batch_reset_slots_ft.cdc — Admin: batch-reset multiple JanusFT commitment slots.
//
// Clears up to MAX_BATCH_RESET (100) user commitment slots in a single transaction.
// Silently skips users without existing slots (no panic on missing users).
// Panics if `users.length > 100` to prevent gas exhaustion.
//
// Each cleared slot emits JanusFT.SlotReset(user: address) for off-chain audit trail.
//
// Use cases:
//   - Bulk emergency recovery after a protocol incident.
//   - Mainnet preparation cleanup of testnet state.
//   - Batch regulatory compliance clearing.
//
// Signer must hold the JanusFT Admin resource at JanusFT.AdminProofStoragePath.
// Only the contract deployer has this resource.
//
// Args:
//   users   [Address] list to clear — max 100 elements

import "JanusFT"

transaction(users: [Address]) {
    prepare(admin: auth(BorrowValue) &Account) {
        let adminRef = admin.storage.borrow<&JanusFT.Admin>(
            from: JanusFT.AdminProofStoragePath
        ) ?? panic("admin_batch_reset_slots_ft: caller is not the JanusFT admin")

        adminRef.adminBatchResetSlots(users: users)
    }
}
