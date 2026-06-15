import "EVM"

transaction(bytecodeHex: String) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage
            .borrow<auth(EVM.Deploy) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA")

        let result = coa.deploy(
            code: bytecodeHex.decodeHex(),
            gasLimit: 6_000_000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(result.status == EVM.Status.successful,
            message: "Deploy failed: ".concat(result.errorMessage))

        log("Deployed at: ".concat(result.deployedContract!.toString()))
    }
}
