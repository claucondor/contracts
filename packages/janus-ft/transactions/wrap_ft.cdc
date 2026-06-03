// wrap_ft.cdc — Wrap FungibleToken tokens into a JanusFT commitment.
//
// Generic wrapper: works with any underlying FT configured in JanusFT.custodyVaultType.
// For testnet this wraps MockFT; at mainnet swap the underlying to the production FT.
//
// LEAK BY DESIGN: `grossAmount` is a cleartext UFix64 arg (boundary event).
// The Groth16 amount-disclose proof binds `txCommit` to NET (gross - fee).
//
// Fee math (caller computes off-chain via JanusFT.computeFee(gross)):
//   gross = grossAmount
//   fee   = JanusFT.computeFee(gross)
//   net   = grossAmount - fee
// The proof binds to `net`, NOT `gross`. The contract validates this.
//
// Args:
//   registryAddr          Address holding the JanusFT registry (== signer)
//   grossAmount           UFix64 — what the user pulls from their vault (boundary)
//   netAmount             UFix64 — what the commitment binds to (= gross - fee)
//   txCommitX/Y           Pedersen(netAmount, blinding) coordinates
//   amountProof           [UInt256; 8] Groth16 proof (snarkjs format)
//   amountPublicInputs    [UInt256; 3] amount_disclose public signals
//   encryptedSnapshot     [UInt8] AES-GCM ciphertext of (netAmount, blinding); empty OK
//   ephPubX/Y             Sender's ephemeral BabyJub pubkey for snapshot ECDH

import JanusFT from 0x7599043aea001283
import MockFT from 0x7599043aea001283
import FungibleToken from 0x9a0766d93b6608b7
import EVM from 0x8c5303eaa26202d6

transaction(
    registryAddr:       Address,
    grossAmount:        UFix64,
    netAmount:          UFix64,
    txCommitX:          UInt256,
    txCommitY:          UInt256,
    amountProof:        [UInt256],
    amountPublicInputs: [UInt256],
    encryptedSnapshot:  [UInt8],
    ephPubX:            UInt256,
    ephPubY:            UInt256
) {
    let depositVault: @{FungibleToken.Vault}
    let registryRef:  &JanusFT.CommitmentRegistry
    let senderAddress: Address
    let coa:          auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        self.senderAddress = signer.address

        // Withdraw GROSS amount from MockFT vault (fee comes off the top inside the contract)
        let userVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &MockFT.Vault>(
            from: MockFT.VaultStoragePath
        ) ?? panic("wrap_ft: signer has no MockFT vault at ".concat(MockFT.VaultStoragePath.toString()))
        self.depositVault <- userVault.withdraw(amount: grossAmount)

        // Borrow registry (spike: registry must be on signer's account)
        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("wrap_ft: signer must hold the JanusFT registry")

        // COA for cross-VM BabyJub calls
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("wrap_ft: no COA at /storage/evm — run setup_coa first")
    }

    execute {
        self.registryRef.wrap(
            account:            self.senderAddress,
            netAmount:          netAmount,
            depositVault:       <- self.depositVault,
            txCommit:           JanusFT.Commitment(x: txCommitX, y: txCommitY),
            amountProof:        amountProof,
            amountPublicInputs: amountPublicInputs,
            encryptedSnapshot:  encryptedSnapshot,
            ephPubX:            ephPubX,
            ephPubY:            ephPubY,
            coa:                self.coa
        )
    }
}
