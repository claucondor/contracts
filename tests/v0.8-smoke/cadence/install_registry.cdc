/// install_registry.cdc — Install JanusFT CommitmentRegistry (idempotent).
/// Any user runs this before wrapping MockFT.

import "JanusFT"
import "MockFT"
import "FungibleToken"

transaction {
    prepare(signer: auth(BorrowValue, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {
        let storagePath = JanusFT.CommitmentRegistryStoragePath
        let publicPath  = JanusFT.CommitmentRegistryPublicPath

        let storedType = signer.storage.type(at: storagePath)

        if storedType == nil {
            log("install_registry: installing fresh registry")
            let emptyVault <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
            let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
            signer.storage.save(<- registry, to: storagePath)
        } else if storedType == Type<@JanusFT.CommitmentRegistry>() {
            log("install_registry: registry already installed (correct type) — skipping save")
        } else {
            log("install_registry: stale resource found — destroying and reinstalling")
            let stale <- signer.storage.load<@AnyResource>(from: storagePath)
                ?? panic("install_registry: expected stale resource but load returned nil")
            destroy stale

            let emptyVault <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
            let registry   <- JanusFT.createRegistry(vault: <- emptyVault)
            signer.storage.save(<- registry, to: storagePath)
        }

        signer.capabilities.unpublish(publicPath)
        let cap = signer.capabilities.storage.issue<&{JanusFT.CommitmentRegistryPublic}>(storagePath)
        signer.capabilities.publish(cap, at: publicPath)
        log("install_registry: CommitmentRegistryPublic capability published")
    }
}
