/// setup_registry.cdc — Deploy and configure JanusFT CommitmentRegistry for testing.
///
/// Sets the vault type identifier, installs FeeConfig (0 bps for tests), creates
/// the CommitmentRegistry, and publishes its public capability.
///
/// TESTNET-ONLY — called by the JanusFT Cadence test setup function.

import JanusFT from "JanusFT"
import MockFT from "MockFT"
import FungibleToken from "FungibleToken"

transaction(underlyingType: String) {
    prepare(signer: auth(BorrowValue, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {

        let admin = signer.storage.borrow<&JanusFT.Admin>(
            from: JanusFT.AdminStoragePath
        ) ?? panic("setup_registry: Admin not found")

        admin.setUnderlyingVaultType(typeIdentifier: underlyingType)

        JanusFT.installFeeConfig()

        if signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) == nil {
            let emptyVault <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
            let registry <- JanusFT.createRegistry(vault: <- emptyVault)
            signer.storage.save(<- registry, to: JanusFT.CommitmentRegistryStoragePath)
        }

        signer.capabilities.unpublish(JanusFT.CommitmentRegistryPublicPath)
        let cap = signer.capabilities.storage.issue<&{JanusFT.CommitmentRegistryPublic}>(
            JanusFT.CommitmentRegistryStoragePath
        )
        signer.capabilities.publish(cap, at: JanusFT.CommitmentRegistryPublicPath)
    }
}
