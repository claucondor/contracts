// wrap_ft.cdc — Wrap FungibleToken into a JanusFT commitment (v0.7 aggregate).
//
// Generic wrapper: works with any underlying FT configured in JanusFT.custodyVaultType.
// For testnet this wraps MockFT; at mainnet swap the underlying.
//
// LEAK BY DESIGN: `grossAmount` is a cleartext UFix64 arg (boundary event).
// The AmountDiscloseAggregate circuit (4 public signals) binds the commitment
// to NET amount (post-fee). Fee is deducted inside the contract before proof
// verification; the proof and commitment both encode NET, matching EVM siblings.
//
// Fee math (caller computes off-chain via JanusFT.computeFee(gross)):
//   gross = grossAmount (== vault.balance when passed in)
//   fee   = JanusFT.computeFee(gross)
//   net   = grossAmount - fee
// The circuit binds to `net`, NOT `gross`. (FIX 2026-06-05 — aligns with JanusFlow/JanusERC20)
//
// AmountDiscloseAggregate public inputs (v0.7, 4 signals):
//   [netAmount_uint256, commitX, commitY, nonce]
//
// Args:
//   registryAddr          Address holding the JanusFT registry (== signer)
//   grossAmount           UFix64 — what the user pulls from their vault (boundary)
//   nonce                 UInt256 — anti-replay nonce (must be unused)
//   commitX/Y             2-gen Pedersen commitment coordinates for netAmount
//   pA                    [UInt256; 2] Groth16 proof pA
//   pB                    [[UInt256; 2]; 2] Groth16 proof pB (NOT byte-swapped — contract handles it)
//   pC                    [UInt256; 2] Groth16 proof pC
//   encryptedSnapshot     [UInt8] AES-GCM ciphertext of (netAmount, blinding); required non-empty
//   ephPubkeyX/Y          Sender's ephemeral BabyJub pubkey for snapshot ECDH

import JanusFT from 0xc4e8f99915893a2f
import MockFT from 0x7599043aea001283
import FungibleToken from 0x9a0766d93b6608b7
import EVM from 0x8c5303eaa26202d6

transaction(
    registryAddr:   Address,
    grossAmount:    UFix64,
    nonce:          UInt256,
    commitX:        UInt256,
    commitY:        UInt256,
    pA:             [UInt256],
    pB:             [[UInt256]],
    pC:             [UInt256],
    encryptedSnapshot: [UInt8],
    ephPubkeyX:     UInt256,
    ephPubkeyY:     UInt256
) {
    let depositVault:  @{FungibleToken.Vault}
    let registryRef:   &JanusFT.CommitmentRegistry
    let senderAddress: Address
    let coa:           auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        self.senderAddress = signer.address

        // Withdraw GROSS amount from MockFT vault (fee comes off the top inside the contract)
        let userVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &MockFT.Vault>(
            from: MockFT.VaultStoragePath
        ) ?? panic("wrap_ft: signer has no MockFT vault at ".concat(MockFT.VaultStoragePath.toString()))
        self.depositVault <- userVault.withdraw(amount: grossAmount)

        // Borrow registry (registry must be on signer's account)
        self.registryRef = signer.storage.borrow<&JanusFT.CommitmentRegistry>(
            from: JanusFT.CommitmentRegistryStoragePath
        ) ?? panic("wrap_ft: signer must hold the JanusFT registry")

        // COA for cross-VM BabyJub + verifier calls
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("wrap_ft: no COA at /storage/evm — run setup_coa first")
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
