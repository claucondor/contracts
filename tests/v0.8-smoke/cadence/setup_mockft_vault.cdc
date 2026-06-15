/// setup_mockft_vault.cdc — Idempotent MockFT vault setup.
/// Creates vault, receiver cap, and balance cap for the signer.

import "MockFT"
import "FungibleToken"

transaction {
    prepare(signer: auth(BorrowValue, SaveValue, IssueStorageCapabilityController, PublishCapability) &Account) {
        if signer.storage.borrow<&MockFT.Vault>(from: MockFT.VaultStoragePath) != nil {
            log("setup_mockft_vault: vault already exists — skipping")
            return
        }
        let vault <- MockFT.createEmptyVault(vaultType: Type<@MockFT.Vault>())
        signer.storage.save(<-vault, to: MockFT.VaultStoragePath)

        let receiverCap = signer.capabilities.storage
            .issue<&{FungibleToken.Receiver}>(MockFT.VaultStoragePath)
        signer.capabilities.publish(receiverCap, at: MockFT.ReceiverPublicPath)

        log("setup_mockft_vault: vault created and receiver published")
    }
}
