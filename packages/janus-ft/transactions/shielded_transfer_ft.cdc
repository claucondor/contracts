// shielded_transfer_ft.cdc — Move a hidden amount between two Cadence accounts in JanusFT.
//
// No FT vault moves. Only commitments update on-chain.
// Both sender and recipient receive encrypted blobs so each party can
// independently recover their balance off-chain.
//
// PRIVACY GUARANTEE: The ShieldedTransferWithSnapshot event carries NO cleartext
// amount — only commitment coords and encrypted blobs. Observers cannot determine
// the transfer amount from the event alone.
//
// Uses the ConfidentialTransferAggregateVerifier (v0.7 aggregate scheme).
// Public input shape is unchanged from v0.6: 6 UInt256 signals.
//
// Args:
//   fromAccount           Sender's Cadence address
//   toAccount             Recipient's Cadence address
//   transferProof         [UInt256; 8] Groth16 confidential-transfer-aggregate proof
//   publicInputs          [UInt256; 6] [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
//   encryptedSnapshotFrom [UInt8] AES-GCM snapshot for sender's new balance
//   ephPubFromX/Y         Sender's ephemeral BabyJub pubkey for snapshot ECDH
//   encryptedNoteTo       [UInt8] AES-GCM note for recipient
//   ephPubToX/Y           Sender's ephemeral BabyJub pubkey for recipient note ECDH

import JanusFT from 0xc4e8f99915893a2f
import EVM from 0x8c5303eaa26202d6

transaction(
    fromAccount:            Address,
    toAccount:              Address,
    transferProof:          [UInt256],
    publicInputs:           [UInt256],
    encryptedSnapshotFrom:  [UInt8],
    ephPubFromX:            UInt256,
    ephPubFromY:            UInt256,
    encryptedNoteTo:        [UInt8],
    ephPubToX:              UInt256,
    ephPubToY:              UInt256
) {
    let registryRef: &JanusFT.CommitmentRegistry
    let coa:         auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("shielded_transfer_ft: signer must hold the JanusFT registry")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("shielded_transfer_ft: no COA at /storage/evm")
    }

    execute {
        self.registryRef.shieldedTransfer(
            fromAccount:            fromAccount,
            toAccount:              toAccount,
            transferProof:          transferProof,
            publicInputs:           publicInputs,
            encryptedSnapshotFrom:  encryptedSnapshotFrom,
            ephPubFromX:            ephPubFromX,
            ephPubFromY:            ephPubFromY,
            encryptedNoteTo:        encryptedNoteTo,
            ephPubToX:              ephPubToX,
            ephPubToY:              ephPubToY,
            coa:                    self.coa
        )
    }
}
