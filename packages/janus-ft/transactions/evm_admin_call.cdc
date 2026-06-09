// evm_admin_call.cdc — Generic cross-VM admin call via signer's COA.
//
// Sends an arbitrary calldata payload to a target EVM address using the signer's
// CadenceOwnedAccount (COA). Used for one-time admin initialization calls such as
// initFees(), setFeeBps(), and setFeeRecipient() on JanusToken EVM proxies.
//
// The signer must own the COA that is the EVM contract owner (onlyOwner).
//
// Usage:
//   flow transactions send transactions/evm_admin_call.cdc \
//     <targetAddrHex> <calldataHex> <gasLimit> \
//     --signer v066-admin --network testnet

import EVM from 0x8c5303eaa26202d6

transaction(targetAddrHex: String, calldata: String, gasLimit: UInt64) {
    prepare(signer: auth(BorrowValue) &Account) {
        let coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
            from: /storage/evm
        ) ?? panic("evm_admin_call: no COA at /storage/evm")

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

        log("EVM call succeeded to: ".concat(targetAddrHex))
    }
}
