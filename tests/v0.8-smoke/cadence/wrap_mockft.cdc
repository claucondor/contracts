/// wrap_mockft.cdc — Wrap MockFT into JanusFT commitment with amount-disclose proof.

import "JanusFT"
import "MockFT"
import "FungibleToken"
import "EVM"

transaction(
    grossAmount:       UFix64,
    nonce:             UInt256,
    commitX:           UInt256,
    commitY:           UInt256,
    pA:                [UInt256],
    pB:                [[UInt256]],
    pC:                [UInt256],
    encryptedSnapshot: [UInt8],
    ephPubkeyX:        UInt256,
    ephPubkeyY:        UInt256
) {
    let depositVault: @{FungibleToken.Vault}
    let registryRef:  &JanusFT.CommitmentRegistry
    let senderAddress: Address
    let coa:          auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        self.senderAddress = signer.address

        let userVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &MockFT.Vault>(
            from: MockFT.VaultStoragePath
        ) ?? panic("wrap_mockft: signer has no MockFT vault")
        self.depositVault <- userVault.withdraw(amount: grossAmount)

        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("wrap_mockft: signer must hold the JanusFT registry — run install_registry first")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("wrap_mockft: no COA at /storage/evm")
    }

    execute {
        self.registryRef.wrapWithProof(
            account:           self.senderAddress,
            nonce:             nonce,
            commitX:           commitX,
            commitY:           commitY,
            pA:                pA,
            pB:                pB,
            pC:                pC,
            encryptedSnapshot: encryptedSnapshot,
            ephPubkeyX:        ephPubkeyX,
            ephPubkeyY:        ephPubkeyY,
            vault:             <- self.depositVault,
            coa:               self.coa
        )
    }
}
