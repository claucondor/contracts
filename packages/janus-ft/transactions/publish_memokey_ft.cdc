// publish_memokey_ft.cdc — Cross-VM BabyJub memo pubkey registration for JanusFT users.
//
// Publishes the caller's BabyJub pubkey to BOTH:
//   1. Cadence storage (/storage/openjanusMemoKey via JanusFlow.MemoKey resource)
//      — readable by JanusFT and any future Cadence Janus tokens.
//   2. The shared EVM MemoKeyRegistry (0x05D104962ff087441f26BA11A1E1C3b9E091D663)
//      — readable by JanusFlow, JanusWFLOW, JanusMockUSDC EVM proxies.
//
// After this single Cadence transaction the user's memo key is available from
// ALL four Janus token adapters (flow/wflow/mockusdc via EVM registry,
// ft/mockft via Cadence storage path).
//
// Caller must have a COA at /storage/evm to reach the EVM registry.
//
// MEMO_REGISTRY_ADDRESS: 0x05D104962ff087441f26BA11A1E1C3b9E091D663
//
// Args:
//   memoPubX  BabyJub pubkey X coordinate (UInt256)
//   memoPubY  BabyJub pubkey Y coordinate (UInt256)

import JanusFT from 0x7599043aea001283
import JanusFlow from 0x5dcbeb41055ec57e
import EVM from 0x8c5303eaa26202d6

transaction(memoPubX: UInt256, memoPubY: UInt256) {
    prepare(signer: auth(BorrowValue, IssueStorageCapabilityController, PublishCapability, SaveValue, Storage) &Account) {

        // ----------------------------------------------------------------
        // 1. Publish to Cadence storage path.
        //    JanusFT.publishMemoKey writes to /storage/openjanusMemoKey
        //    (shared with JanusFlow.MemoKey resource — one path, all Cadence tokens).
        // ----------------------------------------------------------------
        JanusFT.publishMemoKey(
            account: signer,
            pubkeyX: memoPubX,
            pubkeyY: memoPubY
        )
        log("Cadence MemoKey published at /storage/openjanusMemoKey")

        // ----------------------------------------------------------------
        // 2. Publish to EVM MemoKeyRegistry via COA cross-VM call.
        //    msg.sender in the EVM call is the user's COA address, which is
        //    the identity used by the EVM Janus token adapters.
        // ----------------------------------------------------------------
        let coa = signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("No COA at /storage/evm")

        let memoRegistryAddr = EVM.addressFromString("0x05D104962ff087441f26BA11A1E1C3b9E091D663")

        // ABI-encode: publishMemoKey(uint256,uint256)
        // selector = keccak256("publishMemoKey(uint256,uint256)")[0:4] = 0xe50a8aad
        let calldata = EVM.encodeABIWithSignature(
            "publishMemoKey(uint256,uint256)",
            [memoPubX, memoPubY]
        )

        let result = coa.call(
            to: memoRegistryAddr,
            data: calldata,
            gasLimit: 100000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "EVM MemoKeyRegistry.publishMemoKey failed — errorCode: "
                .concat(result.errorCode.toString())
                .concat(" ")
                .concat(result.errorMessage)
        )
        log("EVM MemoKeyRegistry.publishMemoKey succeeded for COA: ".concat(coa.address().toString()))
    }
}
