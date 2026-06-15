/// fund_deployer_evm.cdc — Top up deployer EOA from Cadence account via COA.
/// 1. Deposits FLOW from the signer's Cadence vault into the signer's COA.
/// 2. Calls the target EVM address with the specified value (native FLOW transfer).

import "FlowToken"
import "FungibleToken"
import "EVM"

transaction(targetAddrHex: String, amount: UFix64) {
    let coa:   auth(EVM.Call) &EVM.CadenceOwnedAccount
    let vault: @FlowToken.Vault

    prepare(signer: auth(BorrowValue) &Account) {
        self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("fund_deployer_evm: no COA at /storage/evm")

        let flowVault = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(
            from: /storage/flowTokenVault
        ) ?? panic("fund_deployer_evm: no FlowToken vault")

        self.vault <- flowVault.withdraw(amount: amount) as! @FlowToken.Vault
    }

    execute {
        // Step 1: bring FLOW into the COA's EVM balance
        self.coa.deposit(from: <- self.vault)

        // Step 2: transfer from COA to the target EOA via a zero-data call with value
        let target = EVM.addressFromString(targetAddrHex)

        // Convert UFix64 → attoflow (1 FLOW = 1e18 attoflow; UFix64 has 8 decimal places)
        let attoflow: UInt = UInt(amount * 100_000_000.0) * 10_000_000_000

        let result = self.coa.call(
            to: target,
            data: [],
            gasLimit: 21_000,
            value: EVM.Balance(attoflow: attoflow)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "fund_deployer_evm: EVM transfer failed code="
                .concat(result.errorCode.toString())
                .concat(" msg=").concat(result.errorMessage)
        )

        log("fund_deployer_evm: sent ".concat(amount.toString()).concat(" FLOW to ").concat(targetAddrHex))
    }
}
