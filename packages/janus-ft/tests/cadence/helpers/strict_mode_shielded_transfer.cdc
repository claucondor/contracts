/// strict_mode_shielded_transfer.cdc — Test helper: call shieldedTransfer with dummy
/// proof and public inputs.  Used to test the strict-mode inbox guard.
///
/// In strict mode, shieldedTransfer checks recipient inbox FIRST (before ZK verification).
/// If the recipient has no inbox, this transaction panics with:
///   "JanusFT: recipient has not installed ShieldedInbox — they must call install_inbox first"
///
/// publicInputs are set to the identity commitment (0, 1) for the C_old check so the
/// precondition passes — the inbox panic fires before the C_old assertion or ZK call.
///
/// The signer provides their own COA; the registry is borrowed from JanusFT's deployer
/// account via the public CommitmentRegistryPublic capability.
///
/// Args:
///   fromAccount  Sender address (the signer's address)
///   toAccount    Recipient address — MUST NOT have an inbox for the panic test

import "JanusFT"
import "EVM"

transaction(fromAccount: Address, toAccount: Address) {
    let registryRef: &{JanusFT.CommitmentRegistryPublic}
    let coa:         auth(EVM.Call) &EVM.CadenceOwnedAccount

    prepare(signer: auth(BorrowValue) &Account) {
        let deployerAddr = JanusFT.registryAddress()
        self.registryRef = getAccount(deployerAddr)
            .capabilities.borrow<&{JanusFT.CommitmentRegistryPublic}>(
                JanusFT.CommitmentRegistryPublicPath
            ) ?? panic("strict_mode_shielded_transfer: no JanusFT registry published at deployer account")

        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("strict_mode_shielded_transfer: no COA at /storage/evm")
    }

    execute {
        // dummy proof / public inputs — panic fires at inbox check before these are used
        self.registryRef.shieldedTransfer(
            fromAccount:     fromAccount,
            toAccount:       toAccount,
            transferProof:   [0, 0, 0, 0, 0, 0, 0, 0],
            publicInputs:    [0, 1, 0, 0, 0, 0],   // identity C_old for fromAccount
            encryptedNoteTo: [0x01],
            ephPubToX:       1,
            ephPubToY:       1,
            coa:             self.coa
        )
    }
}
