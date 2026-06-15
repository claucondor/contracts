/// shielded_transfer_mockft.cdc — JanusFT shielded transfer (v0.8).
/// Signer is the sender. Recipient must have ShieldedInbox installed.

import "JanusFT"
import "EVM"

transaction(
    fromAccount:     Address,
    toAccount:       Address,
    transferProof:   [UInt256],
    publicInputs:    [UInt256],
    encryptedNoteTo: [UInt8],
    ephPubToX:       UInt256,
    ephPubToY:       UInt256
) {
    let registryRef: &{JanusFT.CommitmentRegistryPublic}
    let coa:         auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        let deployerAddr = JanusFT.registryAddress()
        self.registryRef = getAccount(deployerAddr)
            .capabilities.borrow<&{JanusFT.CommitmentRegistryPublic}>(
                JanusFT.CommitmentRegistryPublicPath
            ) ?? panic("shielded_transfer_mockft: JanusFT registry capability not published")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("shielded_transfer_mockft: no COA at /storage/evm")
    }

    execute {
        self.registryRef.shieldedTransfer(
            fromAccount:     fromAccount,
            toAccount:       toAccount,
            transferProof:   transferProof,
            publicInputs:    publicInputs,
            encryptedNoteTo: encryptedNoteTo,
            ephPubToX:       ephPubToX,
            ephPubToY:       ephPubToY,
            coa:             self.coa
        )
    }
}
