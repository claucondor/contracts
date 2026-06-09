/// unwrap_mockft.cdc — Unwrap JanusFT commitment back to MockFT.
/// Signer must hold the JanusFT CommitmentRegistry and a COA.
/// Recipient receives MockFT tokens.

import "JanusFT"
import "MockFT"
import "FungibleToken"
import "EVM"

transaction(
    account:               Address,
    claimedAmount:         UFix64,
    recipient:             Address,
    txCommitX:             UInt256,
    txCommitY:             UInt256,
    amountProof:           [UInt256],
    amountPublicInputs:    [UInt256],
    transferProof:         [UInt256],
    transferPublicInputs:  [UInt256],
    encryptedSnapshot:     [UInt8],
    ephPubX:               UInt256,
    ephPubY:               UInt256
) {
    let registryRef:  &JanusFT.CommitmentRegistry
    let coa:          auth(EVM.Call) &EVM.CadenceOwnedAccount
    let recipientRef: &{FungibleToken.Receiver}

    prepare(signer: auth(BorrowValue) &Account) {
        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("unwrap_mockft: signer must hold the JanusFT registry")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("unwrap_mockft: no COA at /storage/evm")

        self.recipientRef = getAccount(recipient)
            .capabilities.borrow<&{FungibleToken.Receiver}>(MockFT.ReceiverPublicPath)
            ?? panic("unwrap_mockft: recipient has no MockFT Receiver capability")
    }

    execute {
        let netVault <- self.registryRef.unwrap(
            account:               account,
            claimedAmount:         claimedAmount,
            recipient:             recipient,
            txCommit:              JanusFT.Commitment(x: txCommitX, y: txCommitY),
            amountProof:           amountProof,
            amountPublicInputs:    amountPublicInputs,
            transferProof:         transferProof,
            transferPublicInputs:  transferPublicInputs,
            encryptedSnapshot:     encryptedSnapshot,
            ephPubX:               ephPubX,
            ephPubY:               ephPubY,
            coa:                   self.coa
        )
        self.recipientRef.deposit(from: <- netVault)
    }
}
