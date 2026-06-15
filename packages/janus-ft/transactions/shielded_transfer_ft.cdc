// shielded_transfer_ft.cdc — Move a hidden amount between two Cadence accounts in JanusFT.
//
// v0.8 changes:
//   • Removed sender snapshot params (encryptedSnapshotFrom, ephPubFromX/Y).
//     Sender updates their own ShieldedCheckpoint via a SEPARATE composable call or
//     via combined_shielded_transfer_with_checkpoint.cdc for atomic composition.
//   • Recipient MUST have ShieldedInbox installed (strict mode).
//     The contract panics if the recipient's /public/shieldedInbox capability is absent.
//   • The encrypted note is deposited directly to recipient's NoteInbox.
//   • Uses the CommitmentRegistryPublic capability from the JanusFT deployer account,
//     so any user with a COA can send — the signer need not hold the registry themselves.
//
// No FT vault moves. Only commitments update on-chain.
// The recipient's NoteInbox receives the encrypted note ciphertext.
//
// PRIVACY GUARANTEE: The ShieldedTransferNote event carries NO cleartext
// amount — only commitment coords and the encrypted note blob.
// Observers cannot determine the transfer amount from the event alone.
//
// Uses the ConfidentialTransferAggregateVerifier (v0.7 aggregate scheme).
// Public input shape: 6 UInt256 signals.
//
// Args:
//   fromAccount     Sender's Cadence address
//   toAccount       Recipient's Cadence address (must have ShieldedInbox installed)
//   transferProof   [UInt256; 8] Groth16 confidential-transfer-aggregate proof
//   publicInputs    [UInt256; 6] [C_old.x, C_old.y, C_tx.x, C_tx.y, C_new.x, C_new.y]
//   encryptedNoteTo [UInt8] ECIES note for recipient — deposited to their inbox
//   ephPubToX/Y     Sender's ephemeral BabyJub pubkey for recipient note ECDH

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
            ) ?? panic("shielded_transfer_ft: JanusFT registry capability not published — operator must run setup_registry")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("shielded_transfer_ft: no COA at /storage/evm — run create_coa first")
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
