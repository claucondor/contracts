// user_install_janus_ft_registry.cdc — Self-service JanusFT CommitmentRegistry installer.
//
// Any user can run this transaction once before their first MockFT wrap.
// It is fully idempotent and handles three storage states:
//
//   A. Nothing at path → install fresh registry.
//   B. Correct type (A.c4e8f99915893a2f.JanusFT.CommitmentRegistry) → no-op, republish cap.
//   C. Stale resource from a previous JanusFT contract address (e.g. v0.6 residue
//      at A.7599043aea001283.JanusFT.CommitmentRegistry) → load as @AnyResource,
//      destroy it, install fresh registry.
//
// The type-check-then-destroy pattern uses storage.type(at:) to inspect the
// stored type before attempting to load, avoiding a panic on type mismatch:
//   - storage.type(at:) returns the concrete Type of whatever is stored, or nil.
//   - If it's exactly JanusFT.CommitmentRegistry → no-op (case B).
//   - If it's any OTHER resource type → load<@AnyResource> + destroy (case C).
//   - If nil → install new (case A).
//
// After install (or no-op), the CommitmentRegistryPublic capability is
// (re-)published so wrap/transfer/unwrap can borrow it.
//
// Permissions required:
//   BorrowValue, SaveValue, LoadValue,
//   IssueStorageCapabilityController, PublishCapability, UnpublishCapability
//
// NO Admin entitlement required — entirely self-service.

import JanusFT from 0xc4e8f99915893a2f
import MockFT from 0x7599043aea001283
import FungibleToken from 0x9a0766d93b6608b7

transaction {
    prepare(signer: auth(BorrowValue, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {

        let storagePath = JanusFT.CommitmentRegistryStoragePath
        let publicPath  = JanusFT.CommitmentRegistryPublicPath

        // ----------------------------------------------------------------
        // Step 1: inspect what (if anything) is at the storage path.
        // ----------------------------------------------------------------
        let storedType = signer.storage.type(at: storagePath)

        if storedType == nil {
            // Case A: path is empty → install new registry
            log("user_install_janus_ft_registry: path empty — installing fresh registry")

            let emptyVault <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
            let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
            signer.storage.save(<- registry, to: storagePath)

        } else if storedType == Type<@JanusFT.CommitmentRegistry>() {
            // Case B: correct type already present → no-op on storage
            log("user_install_janus_ft_registry: registry already installed (correct type) — skipping save")

        } else {
            // Case C: stale resource from a different contract version → destroy and reinstall
            log("user_install_janus_ft_registry: stale resource found — destroying and reinstalling")

            let stale <- signer.storage.load<@AnyResource>(from: storagePath)
                ?? panic("user_install_janus_ft_registry: expected stale resource but load returned nil")
            destroy stale

            let emptyVault <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
            let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
            signer.storage.save(<- registry, to: storagePath)
        }

        // ----------------------------------------------------------------
        // Step 2: (re-)publish the public capability so callers can borrow it.
        // Unpublish first — safe no-op if nothing is published at that path.
        // ----------------------------------------------------------------
        signer.capabilities.unpublish(publicPath)
        let cap = signer.capabilities.storage.issue<&{JanusFT.CommitmentRegistryPublic}>(storagePath)
        signer.capabilities.publish(cap, at: publicPath)

        log("user_install_janus_ft_registry: CommitmentRegistryPublic capability published")
    }
}
