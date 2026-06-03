// unwrap_ft.cdc — Unwrap JanusFT commitment back to FungibleToken.
//
// LEAK BY DESIGN: `claimedAmount` is a cleartext UFix64 arg (boundary event).
// The Groth16 amount-disclose proof binds `txCommit` to `claimedAmount` (gross).
// Fee is deducted server-side; recipient receives net = claimedAmount - fee.
//
// Two Groth16 proofs are required:
//   1. amountProof   — amount_disclose circuit: binds txCommit to claimedAmount
//   2. transferProof — ConfidentialTransfer circuit: proves C_old → C_new is valid
//
// Both verified cross-VM. Atomic: if either reverts, no state changes.
//
// Args:
//   account               Shielded sender (must hold the commitment on-chain)
//   claimedAmount         UFix64 — gross unwrap amount (boundary leak)
//   recipient             Cadence address to receive NET tokens
//   txCommitX/Y           Pedersen(claimedAmount, blinding) coordinates
//   amountProof           [UInt256; 8] Groth16 amount-disclose proof
//   amountPublicInputs    [UInt256; 3] amount_disclose public signals
//   transferProof         [UInt256; 8] Groth16 confidential-transfer proof
//   transferPublicInputs  [UInt256; 6] [C_old, C_tx, C_new] coordinates
//   encryptedSnapshot     [UInt8] AES-GCM snapshot of residual balance
//   ephPubX/Y             Sender's ephemeral BabyJub pubkey for snapshot ECDH

import JanusFT from 0x7599043aea001283
import MockFT from 0x7599043aea001283
import FungibleToken from 0x9a0766d93b6608b7
import EVM from 0x8c5303eaa26202d6

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
        ) ?? panic("unwrap_ft: signer must hold the JanusFT registry")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("unwrap_ft: no COA at /storage/evm")

        // Borrow recipient's MockFT receiver capability
        self.recipientRef = getAccount(recipient)
            .capabilities.borrow<&{FungibleToken.Receiver}>(MockFT.ReceiverPublicPath)
            ?? panic("unwrap_ft: recipient has no MockFT receiver at ".concat(MockFT.ReceiverPublicPath.toString()))
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

        // Deposit the net vault into the recipient's account
        self.recipientRef.deposit(from: <- netVault)
    }
}
