// combined_shielded_transfer_with_checkpoint.cdc
//
// Atomic composition: shieldedTransfer + sender ShieldedCheckpoint update in ONE transaction.
//
// This is the CANONICAL send pattern for v0.8:
//   1. Proves and executes the shielded transfer (updates commitments on-chain,
//      deposits recipient note to their NoteInbox).
//   2. Immediately updates the sender's ShieldedCheckpoint with the new encrypted
//      state snapshot.  Both operations commit or both revert — no split-brain.
//
// Composability note for PrivateTip (L6+):
//   PrivateTip can use this transaction as a building block.  The caller computes
//   the new encrypted snapshot off-chain (SDK: encryptSnapshot) and passes both
//   the transfer proof and the checkpoint payload in a single transaction.
//
// The recipient's snapshot update is done by the RECIPIENT in their own transaction
// (drain + update_checkpoint pattern), not by the sender.
//
// Args (transfer):
//   fromAccount     Sender's Cadence address
//   toAccount       Recipient's Cadence address (must have ShieldedInbox installed)
//   transferProof   [UInt256; 8] Groth16 confidential-transfer-aggregate proof
//   publicInputs    [UInt256; 6] [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
//   encryptedNoteTo [UInt8] ECIES note for recipient
//   ephPubToX/Y     Ephemeral BabyJub pubkey for recipient note ECDH
//
// Args (sender checkpoint):
//   checkpointToken        String key for the token slot (e.g. "0x" + 16-char Cadence address for
//                          JanusFT, or "0x" + 40-char lowercase hex for an EVM token).
//   checkpointSnapshot     [UInt8] ECIES-encrypted snapshot of sender's new balance state
//   checkpointEphPubX/Y    Ephemeral BabyJub pubkey used to encrypt the snapshot
//   lastConsumedNoteIndex  Cursor: how many of the sender's inbox notes are consumed

import "JanusFT"
import "ShieldedCheckpoint"
import "EVM"

transaction(
    fromAccount:            Address,
    toAccount:              Address,
    transferProof:          [UInt256],
    publicInputs:           [UInt256],
    encryptedNoteTo:        [UInt8],
    ephPubToX:              UInt256,
    ephPubToY:              UInt256,
    checkpointToken:        String,
    checkpointSnapshot:     [UInt8],
    checkpointEphPubX:      UInt256,
    checkpointEphPubY:      UInt256,
    lastConsumedNoteIndex:  UInt64
) {
    let registryRef:  &{JanusFT.CommitmentRegistryPublic}
    let coa:          auth(EVM.Call) &EVM.CadenceOwnedAccount
    let checkpoint:   auth(ShieldedCheckpoint.Owner) &ShieldedCheckpoint.Checkpoint

    prepare(signer: auth(BorrowValue) &Account) {
        let deployerAddr = JanusFT.registryAddress()
        self.registryRef = getAccount(deployerAddr)
            .capabilities.borrow<&{JanusFT.CommitmentRegistryPublic}>(
                JanusFT.CommitmentRegistryPublicPath
            ) ?? panic("combined_shielded_transfer_with_checkpoint: JanusFT registry capability not published")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("combined_shielded_transfer_with_checkpoint: no COA at /storage/evm")

        self.checkpoint = signer.storage.borrow<auth(ShieldedCheckpoint.Owner) &ShieldedCheckpoint.Checkpoint>(
            from: /storage/shieldedCheckpoint
        ) ?? panic("combined_shielded_transfer_with_checkpoint: ShieldedCheckpoint not installed — run install_checkpoint first")
    }

    execute {
        // ── 1. Shielded transfer (updates commitments + deposits note to inbox) ──
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

        // ── 2. Sender checkpoint update (records new encrypted state) ───────────
        // This updates the sender's ShieldedCheckpoint with the post-transfer
        // encrypted snapshot.  Atomic with the transfer: both commit or both revert.
        // checkpointToken identifies the per-token slot — caller passes the JanusFT
        // Cadence address string (e.g. "0x" + 16-char address) or EVM token address.
        self.checkpoint.update(
            token:                 checkpointToken,
            encryptedSnapshot:     checkpointSnapshot,
            ephPubkeyX:            checkpointEphPubX,
            ephPubkeyY:            checkpointEphPubY,
            lastConsumedNoteIndex: lastConsumedNoteIndex
        )
    }
}
