// setup_janus_ft_registry.cdc — Post-deploy initialization for JanusFT v0.8.
//
// Run ONCE by the deployer account after deploying JanusFT to a new account.
//
// This transaction:
//   1. Sets underlyingVaultTypeIdentifier to the testnet MockFT vault type.
//   2. Installs the FeeConfig resource (idempotent).
//   3. Creates a CommitmentRegistry with an empty MockFT vault (if not exists).
//   4. Publishes the CommitmentRegistryPublic capability (includes shieldedTransfer in v0.8).
//   5. Initializes fees: feeBps, feeRecipient, feeReceiverPath.
//
// For testnet MockFT (deployed at 0x7599043aea001283):
//   underlyingType  = "A.7599043aea001283.MockFT.Vault"
//   feeBps          = 10  (0.1%)
//   feeRecipient    = deployer address (v066-admin: 0xc4e8f99915893a2f)
//   feeReceiverPath = /public/mockFTReceiver
//
// v0.8 DEPENDENCY ADDRESSES (shielded-recovery primitives, testnet):
//   ShieldedInbox:      TBD — deploy from packages/shielded-recovery before first transfer
//   ShieldedCheckpoint: TBD — deploy from packages/shielded-recovery before first transfer
//
// v0.8 RECIPIENT PREREQUISITE:
//   All transfer recipients MUST install ShieldedInbox before receiving a shieldedTransfer.
//   Strict-mode panics immediately if /public/shieldedInbox is absent.
//   Recipients run: flow transactions send transactions/user_install_janus_ft_registry.cdc
//   (or the shielded-recovery install_inbox.cdc transaction)
//
// NOTE: The JanusFT contract address in the import must match the deployment target.
// This template uses JanusFT at the canonical testnet address set in flow.json aliases.

import JanusFT from 0xc4e8f99915893a2f
import MockFT from 0x7599043aea001283
import FungibleToken from 0x9a0766d93b6608b7

transaction(underlyingType: String, feeBps: UInt16, feeRecipient: Address, feeReceiverPath: PublicPath) {

    prepare(signer: auth(BorrowValue, SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account) {

        // 1. Set the underlying vault type identifier (via Admin)
        let admin = signer.storage.borrow<&JanusFT.Admin>(
            from: JanusFT.AdminStoragePath
        ) ?? panic("setup_janus_ft_registry: Admin not found")

        admin.setUnderlyingVaultType(typeIdentifier: underlyingType)
        log("underlyingVaultTypeIdentifier set to: ".concat(underlyingType))

        // 2. Install FeeConfig (idempotent)
        JanusFT.installFeeConfig()
        log("FeeConfig installed")

        // 3. Create CommitmentRegistry if not present
        if signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) == nil {
            // Create an empty MockFT vault for the registry
            let emptyVault <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
            let registry <- JanusFT.createRegistry(vault: <- emptyVault)
            signer.storage.save(<- registry, to: JanusFT.CommitmentRegistryStoragePath)
            log("JanusFT registry created")
        } else {
            log("JanusFT registry already exists — skipping")
        }

        // 4. Publish CommitmentRegistryPublic capability
        let publicPath = JanusFT.CommitmentRegistryPublicPath
        signer.capabilities.unpublish(publicPath)
        let cap = signer.capabilities.storage.issue<&{JanusFT.CommitmentRegistryPublic}>(
            JanusFT.CommitmentRegistryStoragePath
        )
        signer.capabilities.publish(cap, at: publicPath)
        log("CommitmentRegistry cap published")

        // 5. Initialize fees
        if !JanusFT.feesInitialized() {
            admin.initFees(recipient: feeRecipient, bps: feeBps, receiverPath: feeReceiverPath)
            log("Fees initialized: bps=".concat(feeBps.toString()))
        } else {
            log("Fees already initialized — skipping")
        }
    }
}
