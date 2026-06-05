// unwrap_ft.cdc — Unwrap JanusFT commitment back to FungibleToken (v0.7 aggregate).
//
// LEAK BY DESIGN: `claimedAmount` is a cleartext UFix64 arg (boundary event).
// The AmountDiscloseAggregate proof binds txCommit to claimedAmount.
// nonce = 0 is used for the amount-disclose proof on unwrap; anti-replay
// is enforced by the transfer-proof's C_old state-machine check.
//
// Two Groth16 proofs are required:
//   1. amountProof   — AmountDiscloseAggregate circuit (4 public inputs):
//                        [claimedAmount_uint256, txCommit.x, txCommit.y, 0]
//   2. transferProof — ConfidentialTransferAggregate circuit (6 public inputs):
//                        [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
//
// Both verified cross-VM. Atomic: if either reverts, no state changes.
//
// Args:
//   account               Shielded sender (must hold the commitment on-chain)
//   claimedAmount         UFix64 — gross unwrap amount (boundary leak)
//   recipient             Cadence address to receive NET tokens
//   txCommitX/Y           Pedersen(claimedAmount, blinding) coordinates
//   amountProof           [UInt256; 8] Groth16 amount-disclose proof
//   amountPublicInputs    [UInt256; 4] amount_disclose public signals (nonce=0)
//   transferProof         [UInt256; 8] Groth16 confidential-transfer proof
//   transferPublicInputs  [UInt256; 6] [C_old, C_tx, C_new] coordinates
//   encryptedSnapshot     [UInt8] AES-GCM snapshot of residual balance
//   ephPubX/Y             Sender's ephemeral BabyJub pubkey for snapshot ECDH

import JanusFT from 0xc4e8f99915893a2f
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
