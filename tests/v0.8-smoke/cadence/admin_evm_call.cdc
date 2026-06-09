/// admin_evm_call.cdc — Generic cross-VM admin call via signer's COA.
/// Sends an arbitrary calldata payload to a target EVM address using the signer's
/// CadenceOwnedAccount (COA). Used for adminBatchResetSlots on JanusFlow and JanusERC20.

import "EVM"

transaction(targetAddrHex: String, calldata: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("admin_evm_call: no COA at /storage/evm")

        let target = EVM.addressFromString(targetAddrHex)

        let result = coa.call(
            to: target,
            data: calldata.decodeHex(),
            gasLimit: gasLimit,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "EVM call reverted: "
                .concat(result.errorCode.toString())
                .concat(" ")
                .concat(result.errorMessage)
                .concat(" data: 0x")
                .concat(String.encodeHex(result.data))
        )

        log("admin_evm_call: succeeded — target=".concat(targetAddrHex))
    }
}
