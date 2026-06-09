/// create_coa.cdc — Test helper: create a CadenceOwnedAccount (COA) for a test account.
///
/// Required for strict-mode tests: shieldedTransfer takes a COA param even though
/// the panic fires before any cross-VM call (in strict mode when inbox is absent).
/// The transaction must successfully borrow a COA in prepare() to reach execute().
///
/// Only run once per account: idempotent guard prevents double-creation.

import EVM from "EVM"

transaction {
    prepare(signer: auth(SaveValue, BorrowValue, IssueStorageCapabilityController, PublishCapability) &Account) {
        if signer.storage.type(at: /storage/evm) != nil {
            return
        }
        let coa <- EVM.createCadenceOwnedAccount()
        signer.storage.save(<-coa, to: /storage/evm)
        let cap = signer.capabilities.storage
            .issue<&EVM.CadenceOwnedAccount>(/storage/evm)
        signer.capabilities.publish(cap, at: /public/evm)
    }
}
