// JanusFT.cdc — Production confidential-amount wrapper for any Cadence FungibleToken.
//
// This is the PRODUCTION contract — no stubs, real BabyJub cross-VM, real Groth16 ZK.
//
// UPGRADE NOTES (from lab-spike v0.0 → production v0.6):
//   All existing contract-level fields are preserved verbatim for Cadence upgrade-validator
//   compatibility. New EVM addresses and curve constants are exposed as view functions
//   rather than stored fields. custodyVaultType is derived from the existing
//   underlyingVaultTypeIdentifier String field via CompositeType() at call time.
//
// Architecture:
//   - Generic: wraps ANY @{FungibleToken.Vault} underlying (underlyingVaultTypeIdentifier).
//     For testnet this is A.7599043aea001283.MockFT.Vault; at mainnet swap the underlying.
//   - Pedersen commitments tracked per-account on Cadence.
//   - All BabyJubJub EC point arithmetic delegated to BabyJub.sol on Flow EVM
//     via cross-VM call through the caller's COA.
//   - ZK proof verification (amount_disclose + ConfidentialTransfer) done
//     cross-VM via ConfidentialTransferVerifier.sol and AmountDiscloseVerifier.sol.
//   - MemoKey: uses JanusFlow.MemoKey from 0x5dcbeb41055ec57e — shared
//     generic BabyJub pubkey resource.
//   - publishMemoKey: Cadence-only. MemoKey at canonical /storage/openjanusMemoKey.
//   - Events follow v0.6 schema with snapshot ciphertexts.
//
// EVM contracts used (Flow EVM testnet, chainId 545):
//   BabyJub.sol:                        0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
//   ConfidentialTransferVerifier.sol:   0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B
//   AmountDiscloseVerifier.sol:         0xD0ED3936530258C278f5357C1dB709ad34768352
//
// SECURITY NOTE: EXPERIMENTAL. Not audited. Do not use with real funds.

import FungibleToken from 0x9a0766d93b6608b7
import EVM from 0x8c5303eaa26202d6
import JanusFlow from 0x5dcbeb41055ec57e

access(all) contract JanusFT {

    // -----------------------------------------------------------------------
    // EVM contract addresses — returned as view functions (upgrade-safe,
    // no new stored fields needed).
    // -----------------------------------------------------------------------

    /// BabyJub.sol — EC point arithmetic for BabyJubJub curve
    access(all) view fun BABYJUB_ADDR(): String {
        return "0x27139AFda7425f51F68D32e0A38b7D43BcB0f870"
    }

    /// ConfidentialTransferVerifier.sol — Groth16 shielded-transfer verifier
    access(all) view fun TRANSFER_VERIFIER_ADDR(): String {
        return "0x84852aF72D2EF2A0A937e8Dae0BFA482E707E39B"
    }

    /// AmountDiscloseVerifier.sol — Groth16 amount-disclose verifier (wrap/unwrap)
    access(all) view fun AMOUNT_VERIFIER_ADDR(): String {
        return "0xD0ED3936530258C278f5357C1dB709ad34768352"
    }

    /// BN254 field prime (= BabyJubJub base field prime)
    access(all) view fun BN254_P(): UInt256 {
        return 21888242871839275222246405745257275088548364400416034343698204186575808495617
    }

    /// custodyVaultType — derived from underlyingVaultTypeIdentifier at call time.
    /// Uses Cadence's CompositeType() to reconstruct the Type from the stored string.
    /// view: CompositeType() is a pure function in Cadence (reads type registry only).
    access(all) view fun custodyVaultType(): Type {
        return CompositeType(self.underlyingVaultTypeIdentifier)
            ?? panic("JanusFT: invalid underlyingVaultTypeIdentifier — cannot reconstruct Type")
    }

    // -----------------------------------------------------------------------
    // Storage paths
    // -----------------------------------------------------------------------

    // PRESERVED: same as old contract (upgrade-safe)
    access(all) let AdminStoragePath:               StoragePath
    access(all) let CommitmentRegistryStoragePath:  StoragePath
    access(all) let CommitmentRegistryPublicPath:   PublicPath

    // -----------------------------------------------------------------------
    // State — PRESERVED from old contract (upgrade-safe)
    // -----------------------------------------------------------------------

    /// Vault type identifier as a string (old-format field kept for upgrade compat).
    /// New code uses custodyVaultType() to get the Type via CompositeType().
    access(all) var underlyingVaultTypeIdentifier: String

    /// Aggregate pool — visible by design (boundary accounting).
    access(all) var totalLocked: UFix64

    /// Per-account commitment storage.
    /// (0, 1) is the BabyJubJub identity (no-balance sentinel).
    access(all) struct Commitment {
        access(all) let x: UInt256
        access(all) let y: UInt256
        init(x: UInt256, y: UInt256) {
            self.x = x
            self.y = y
        }
    }

    access(self) var commitments: {Address: Commitment}

    /// Homomorphic sum of all per-account commitments.
    access(all) var totalSupplyCommitment: Commitment

    // -----------------------------------------------------------------------
    // Events
    //
    // DEPRECATED (lab-spike v0.0, preserved for upgrade-validator compat):
    //   Wrapped / Unwrapped / ShieldedTransferred — never emitted in v0.6.
    // These MUST be kept because Cadence upgrade validator forbids removing events.
    //
    // NEW (v0.6 production — snapshot ciphertexts):
    //   WrapWithSnapshot / ShieldedTransferWithSnapshot / UnwrapWithSnapshot
    // -----------------------------------------------------------------------

    /// @deprecated — kept for upgrade compat (lab spike v0.0). NOT emitted.
    access(all) event Wrapped(account: Address, amount: UFix64)

    /// @deprecated — kept for upgrade compat (lab spike v0.0). NOT emitted.
    access(all) event Unwrapped(account: Address, recipient: Address, amount: UFix64)

    /// @deprecated — kept for upgrade compat (lab spike v0.0). NOT emitted.
    access(all) event ShieldedTransferred(
        fromCommitX: UInt256, fromCommitY: UInt256,
        toCommitX: UInt256, toCommitY: UInt256
    )

    /// LEAK BY DESIGN — boundary event reveals deposit amount.
    access(all) event WrapWithSnapshot(
        account:           Address,
        commitX:           UInt256,
        commitY:           UInt256,
        encryptedSnapshot: [UInt8],
        ephPubX:           UInt256,
        ephPubY:           UInt256
    )

    /// HIDE — no cleartext amount; snapshot allows sender to recover balance.
    access(all) event ShieldedTransferWithSnapshot(
        fromCommitX:           UInt256,
        fromCommitY:           UInt256,
        toCommitX:             UInt256,
        toCommitY:             UInt256,
        encryptedSnapshotFrom: [UInt8],
        ephPubFromX:           UInt256,
        ephPubFromY:           UInt256,
        encryptedNoteTo:       [UInt8],
        ephPubToX:             UInt256,
        ephPubToY:             UInt256
    )

    /// LEAK BY DESIGN — boundary event reveals withdrawal amount.
    access(all) event UnwrapWithSnapshot(
        account:           Address,
        recipient:         Address,
        amount:            UFix64,
        encryptedSnapshot: [UInt8],
        ephPubX:           UInt256,
        ephPubY:           UInt256
    )

    /// Emitted when a user publishes their memo encryption pubkey.
    access(all) event MemoKeyPublished(
        account:  Address,
        pubkeyX:  UInt256,
        pubkeyY:  UInt256
    )

    // -----------------------------------------------------------------------
    // Fee events
    // -----------------------------------------------------------------------

    access(all) event FeeCollected(user: Address, fee: UFix64, op: String)
    access(all) event FeeRecipientChanged(oldRecipient: Address, newRecipient: Address)
    access(all) event FeeBpsChanged(oldBps: UInt16, newBps: UInt16)
    access(all) event FeesInitialized(recipient: Address, bps: UInt16)

    // -----------------------------------------------------------------------
    // Fee configuration (Resource + installFeeConfig pattern)
    //
    // NEW: added as a Resource to avoid new contract-level fields (upgrade-safe).
    // FeeConfig is installed via installFeeConfig() and stored at
    // /storage/janusFTFeeConfig on the contract account.
    //
    // feeReceiverPath: the PublicPath at which the fee recipient exposes a
    //   &{FungibleToken.Receiver} capability for the underlying FT.
    //   For MockFT: /public/mockFTReceiver.
    // -----------------------------------------------------------------------

    access(all) view fun MAX_FEE_BPS(): UInt16 { return 100 }

    access(all) view fun feeConfigStoragePath(): StoragePath {
        return /storage/janusFTFeeConfig
    }

    access(all) resource FeeConfig {
        access(all) var recipient:     Address
        access(all) var bps:           UInt16
        access(all) var initialized:   Bool
        access(all) var receiverPath:  PublicPath

        init() {
            self.recipient    = JanusFT.account.address
            self.bps          = 0
            self.initialized  = false
            self.receiverPath = /public/fungibleTokenReceiver
        }

        access(contract) fun initialize(recipient: Address, bps: UInt16, receiverPath: PublicPath) {
            pre {
                !self.initialized: "JanusFT.FeeConfig: already initialized"
                bps <= JanusFT.MAX_FEE_BPS(): "JanusFT.FeeConfig: bps exceeds MAX_FEE_BPS"
            }
            self.recipient    = recipient
            self.bps          = bps
            self.receiverPath = receiverPath
            self.initialized  = true
        }

        access(contract) fun setBps(_ newBps: UInt16) {
            pre { newBps <= JanusFT.MAX_FEE_BPS(): "JanusFT.FeeConfig: bps exceeds MAX_FEE_BPS" }
            self.bps = newBps
        }

        access(contract) fun setRecipient(_ newRecipient: Address) {
            self.recipient = newRecipient
        }

        access(contract) fun setReceiverPath(_ newPath: PublicPath) {
            self.receiverPath = newPath
        }
    }

    access(all) fun installFeeConfig() {
        let path = self.feeConfigStoragePath()
        if self.account.storage.borrow<&FeeConfig>(from: path) == nil {
            self.account.storage.save(<- create FeeConfig(), to: path)
        }
    }

    access(all) fun feeBps(): UInt16 {
        if let cfg = self.account.storage.borrow<&FeeConfig>(from: self.feeConfigStoragePath()) {
            return cfg.bps
        }
        return 0
    }

    access(all) fun feeRecipient(): Address {
        if let cfg = self.account.storage.borrow<&FeeConfig>(from: self.feeConfigStoragePath()) {
            return cfg.recipient
        }
        return self.account.address
    }

    access(all) fun feeReceiverPath(): PublicPath {
        if let cfg = self.account.storage.borrow<&FeeConfig>(from: self.feeConfigStoragePath()) {
            return cfg.receiverPath
        }
        return /public/fungibleTokenReceiver
    }

    access(all) fun feesInitialized(): Bool {
        if let cfg = self.account.storage.borrow<&FeeConfig>(from: self.feeConfigStoragePath()) {
            return cfg.initialized
        }
        return false
    }

    access(all) fun computeFee(gross: UFix64): UFix64 {
        let bps = self.feeBps()
        if bps == 0 { return 0.0 }
        return gross * UFix64(bps) / 10000.0
    }

    // -----------------------------------------------------------------------
    // BabyJubJub helpers (cross-VM)
    // -----------------------------------------------------------------------

    access(self) fun _babyAdd(
        a: Commitment,
        b: Commitment,
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): Commitment {
        let helperAddr = EVM.addressFromString(JanusFT.BABYJUB_ADDR())
        let SEL: [UInt8] = [0xa5, 0x4a, 0x08, 0x68]
        let calldata = SEL.concat(EVM.encodeABI([a.x, a.y, b.x, b.y]))

        let result = coa.call(
            to: helperAddr,
            data: calldata,
            gasLimit: 80_000,
            value: EVM.Balance(attoflow: 0)
        )

        assert(
            result.status == EVM.Status.successful,
            message: "JanusFT._babyAdd: EVM call failed [code="
                .concat(result.errorCode.toString()).concat("]: ")
                .concat(result.errorMessage)
        )

        let decoded = EVM.decodeABI(types: [Type<UInt256>(), Type<UInt256>()], data: result.data)
        return Commitment(x: decoded[0] as! UInt256, y: decoded[1] as! UInt256)
    }

    access(self) fun _babyNegate(c: Commitment): Commitment {
        let p = JanusFT.BN254_P()
        let nx: UInt256 = c.x == 0 ? 0 : p - c.x
        return Commitment(x: nx, y: c.y)
    }

    access(self) fun _babySubtract(
        a: Commitment,
        b: Commitment,
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): Commitment {
        return JanusFT._babyAdd(a: a, b: JanusFT._babyNegate(c: b), coa: coa)
    }

    // -----------------------------------------------------------------------
    // ZK proof verification helpers (cross-VM, Groth16)
    // -----------------------------------------------------------------------

    access(self) fun _verifyAmountProof(
        proof: [UInt256],
        publicInputs: [UInt256],
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): Bool {
        pre {
            proof.length == 8:        "JanusFT: amount proof must be 8 limbs"
            publicInputs.length == 3: "JanusFT: amount publicInputs must be 3"
        }
        let SEL: [UInt8] = [0x11, 0x47, 0x9f, 0xea]
        return JanusFT._verifyGroth16(
            selectorBytes: SEL, verifierAddr: JanusFT.AMOUNT_VERIFIER_ADDR(),
            proof: proof, numPublicInputs: 3, publicInputs: publicInputs, coa: coa
        )
    }

    access(self) fun _verifyTransferProof(
        proof: [UInt256],
        publicInputs: [UInt256],
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): Bool {
        pre {
            proof.length == 8:        "JanusFT: transfer proof must be 8 limbs"
            publicInputs.length == 6: "JanusFT: transfer publicInputs must be 6"
        }
        let SEL: [UInt8] = [0xf3, 0x98, 0x78, 0x9b]
        return JanusFT._verifyGroth16(
            selectorBytes: SEL, verifierAddr: JanusFT.TRANSFER_VERIFIER_ADDR(),
            proof: proof, numPublicInputs: 6, publicInputs: publicInputs, coa: coa
        )
    }

    access(self) fun _verifyGroth16(
        selectorBytes: [UInt8],
        verifierAddr: String,
        proof: [UInt256],
        numPublicInputs: Int,
        publicInputs: [UInt256],
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): Bool {
        var calldata: [UInt8] = selectorBytes
        calldata = calldata.concat(EVM.encodeABI([proof[0]]))
        calldata = calldata.concat(EVM.encodeABI([proof[1]]))
        calldata = calldata.concat(EVM.encodeABI([proof[2]]))
        calldata = calldata.concat(EVM.encodeABI([proof[3]]))
        calldata = calldata.concat(EVM.encodeABI([proof[4]]))
        calldata = calldata.concat(EVM.encodeABI([proof[5]]))
        calldata = calldata.concat(EVM.encodeABI([proof[6]]))
        calldata = calldata.concat(EVM.encodeABI([proof[7]]))
        var pi = 0
        while pi < numPublicInputs {
            calldata = calldata.concat(EVM.encodeABI([publicInputs[pi]]))
            pi = pi + 1
        }
        let addr = EVM.addressFromString(verifierAddr)
        let result = coa.call(to: addr, data: calldata, gasLimit: 500_000, value: EVM.Balance(attoflow: 0))
        if result.status != EVM.Status.successful { return false }
        if result.data.length < 32 { return false }
        return result.data[31] == 1
    }

    // -----------------------------------------------------------------------
    // CommitmentRegistry resource
    // -----------------------------------------------------------------------

    access(all) resource interface CommitmentRegistryPublic {
        access(all) fun balanceOfCommitment(account: Address): Commitment
        access(all) view fun getTotalLocked(): UFix64
    }

    access(all) resource CommitmentRegistry: CommitmentRegistryPublic {

        access(self) var vault: @{FungibleToken.Vault}

        init(vault: @{FungibleToken.Vault}) {
            self.vault <- vault
        }

        access(all) fun balanceOfCommitment(account: Address): Commitment {
            return JanusFT.commitments[account] ?? Commitment(x: 0, y: 1)
        }

        access(all) view fun getTotalLocked(): UFix64 {
            return JanusFT.totalLocked
        }

        // ----- wrap -----
        access(all) fun wrap(
            account:              Address,
            netAmount:            UFix64,
            depositVault:         @{FungibleToken.Vault},
            txCommit:             Commitment,
            amountProof:          [UInt256],
            amountPublicInputs:   [UInt256],
            encryptedSnapshot:    [UInt8],
            ephPubX:              UInt256,
            ephPubY:              UInt256,
            coa:                  auth(EVM.Call) &EVM.CadenceOwnedAccount
        ) {
            pre {
                netAmount > 0.0:                    "JanusFT: zero wrap"
                amountProof.length == 8:            "JanusFT: amountProof must have 8 limbs"
                amountPublicInputs.length == 3:     "JanusFT: amountPublicInputs must have 3 elements"
                depositVault.getType() == JanusFT.custodyVaultType():
                    "JanusFT.wrap: depositVault type mismatch — expected custodyVaultType"
            }

            let gross = depositVault.balance
            let fee = JanusFT.computeFee(gross: gross)
            assert(
                gross == netAmount + fee,
                message: "JanusFT.wrap: gross != netAmount + fee"
            )

            let amountVerified = JanusFT._verifyAmountProof(
                proof: amountProof, publicInputs: amountPublicInputs, coa: coa
            )
            assert(amountVerified, message: "JanusFT.wrap: amount proof verification failed")

            if fee > 0.0 {
                let feeVault <- depositVault.withdraw(amount: fee)
                let receiverPath = JanusFT.feeReceiverPath()
                let feeReceiver = getAccount(JanusFT.feeRecipient())
                    .capabilities.borrow<&{FungibleToken.Receiver}>(receiverPath)
                    ?? panic("JanusFT.wrap: feeRecipient has no FungibleToken receiver at configured path")
                feeReceiver.deposit(from: <- feeVault)
                emit FeeCollected(user: account, fee: fee, op: "wrap")
            }

            assert(
                depositVault.balance == netAmount,
                message: "JanusFT.wrap: residual after fee skim != netAmount"
            )
            self.vault.deposit(from: <- depositVault)

            let current = JanusFT.commitments[account] ?? Commitment(x: 0, y: 1)
            let newCommit = JanusFT._babyAdd(a: current, b: txCommit, coa: coa)
            JanusFT.commitments[account] = newCommit

            JanusFT.totalSupplyCommitment = JanusFT._babyAdd(
                a: JanusFT.totalSupplyCommitment, b: txCommit, coa: coa
            )
            JanusFT.totalLocked = JanusFT.totalLocked + netAmount

            emit WrapWithSnapshot(
                account:           account,
                commitX:           newCommit.x,
                commitY:           newCommit.y,
                encryptedSnapshot: encryptedSnapshot,
                ephPubX:           ephPubX,
                ephPubY:           ephPubY
            )
        }

        // ----- shieldedTransfer -----
        access(all) fun shieldedTransfer(
            fromAccount:            Address,
            toAccount:              Address,
            transferProof:          [UInt256],
            publicInputs:           [UInt256],
            encryptedSnapshotFrom:  [UInt8],
            ephPubFromX:            UInt256,
            ephPubFromY:            UInt256,
            encryptedNoteTo:        [UInt8],
            ephPubToX:              UInt256,
            ephPubToY:              UInt256,
            coa:                    auth(EVM.Call) &EVM.CadenceOwnedAccount
        ) {
            pre {
                fromAccount != toAccount: "JanusFT: cannot shieldedTransfer to self"
                transferProof.length == 8: "JanusFT: transferProof must have 8 limbs"
                publicInputs.length == 6:  "JanusFT: publicInputs must have 6 elements"
            }

            let senderCommit = JanusFT.commitments[fromAccount] ?? Commitment(x: 0, y: 1)
            assert(
                publicInputs[0] == senderCommit.x && publicInputs[1] == senderCommit.y,
                message: "JanusFT.shieldedTransfer: C_old mismatch"
            )

            let transferVerified = JanusFT._verifyTransferProof(
                proof: transferProof, publicInputs: publicInputs, coa: coa
            )
            assert(transferVerified, message: "JanusFT.shieldedTransfer: transfer proof failed")

            let txCommit  = Commitment(x: publicInputs[2], y: publicInputs[3])
            let newSender = Commitment(x: publicInputs[4], y: publicInputs[5])

            JanusFT.commitments[fromAccount] = newSender

            let recipientCurrent = JanusFT.commitments[toAccount] ?? Commitment(x: 0, y: 1)
            let newRecipient = JanusFT._babyAdd(a: recipientCurrent, b: txCommit, coa: coa)
            JanusFT.commitments[toAccount] = newRecipient

            emit ShieldedTransferWithSnapshot(
                fromCommitX:           newSender.x,
                fromCommitY:           newSender.y,
                toCommitX:             newRecipient.x,
                toCommitY:             newRecipient.y,
                encryptedSnapshotFrom: encryptedSnapshotFrom,
                ephPubFromX:           ephPubFromX,
                ephPubFromY:           ephPubFromY,
                encryptedNoteTo:       encryptedNoteTo,
                ephPubToX:             ephPubToX,
                ephPubToY:             ephPubToY
            )
        }

        // ----- unwrap -----
        access(all) fun unwrap(
            account:               Address,
            claimedAmount:         UFix64,
            recipient:             Address,
            txCommit:              Commitment,
            amountProof:           [UInt256],
            amountPublicInputs:    [UInt256],
            transferProof:         [UInt256],
            transferPublicInputs:  [UInt256],
            encryptedSnapshot:     [UInt8],
            ephPubX:               UInt256,
            ephPubY:               UInt256,
            coa:                   auth(EVM.Call) &EVM.CadenceOwnedAccount
        ): @{FungibleToken.Vault} {
            pre {
                claimedAmount > 0.0:            "JanusFT: zero unwrap"
                JanusFT.totalLocked >= claimedAmount: "JanusFT: pool exhausted"
                amountProof.length == 8:        "JanusFT: amountProof must have 8 limbs"
                amountPublicInputs.length == 3: "JanusFT: amountPublicInputs must have 3 elements"
                transferProof.length == 8:      "JanusFT: transferProof must have 8 limbs"
                transferPublicInputs.length == 6: "JanusFT: transferPublicInputs must have 6 elements"
            }

            let senderCommit = JanusFT.commitments[account] ?? Commitment(x: 0, y: 1)
            assert(
                transferPublicInputs[0] == senderCommit.x &&
                transferPublicInputs[1] == senderCommit.y,
                message: "JanusFT.unwrap: C_old mismatch"
            )
            assert(
                transferPublicInputs[2] == txCommit.x &&
                transferPublicInputs[3] == txCommit.y,
                message: "JanusFT.unwrap: C_tx mismatch between proofs"
            )

            let amountOk = JanusFT._verifyAmountProof(
                proof: amountProof, publicInputs: amountPublicInputs, coa: coa
            )
            assert(amountOk, message: "JanusFT.unwrap: amount proof failed")

            let transferOk = JanusFT._verifyTransferProof(
                proof: transferProof, publicInputs: transferPublicInputs, coa: coa
            )
            assert(transferOk, message: "JanusFT.unwrap: transfer proof failed")

            JanusFT.commitments[account] = Commitment(
                x: transferPublicInputs[4], y: transferPublicInputs[5]
            )

            JanusFT.totalSupplyCommitment = JanusFT._babySubtract(
                a: JanusFT.totalSupplyCommitment, b: txCommit, coa: coa
            )
            JanusFT.totalLocked = JanusFT.totalLocked - claimedAmount

            let grossVault <- self.vault.withdraw(amount: claimedAmount)

            let fee = JanusFT.computeFee(gross: claimedAmount)
            if fee > 0.0 {
                let feeVault <- grossVault.withdraw(amount: fee)
                let receiverPath = JanusFT.feeReceiverPath()
                let feeReceiver = getAccount(JanusFT.feeRecipient())
                    .capabilities.borrow<&{FungibleToken.Receiver}>(receiverPath)
                    ?? panic("JanusFT.unwrap: feeRecipient has no FungibleToken receiver at configured path")
                feeReceiver.deposit(from: <- feeVault)
                emit FeeCollected(user: account, fee: fee, op: "unwrap")
            }

            let netAmount = claimedAmount - fee
            emit UnwrapWithSnapshot(
                account:           account,
                recipient:         recipient,
                amount:            netAmount,
                encryptedSnapshot: encryptedSnapshot,
                ephPubX:           ephPubX,
                ephPubY:           ephPubY
            )

            return <- grossVault
        }
    }

    // -----------------------------------------------------------------------
    // publishMemoKey — Cadence-only
    // -----------------------------------------------------------------------

    access(all) fun publishMemoKey(
        account:  auth(SaveValue, LoadValue, IssueStorageCapabilityController, PublishCapability, UnpublishCapability) &Account,
        pubkeyX:  UInt256,
        pubkeyY:  UInt256
    ) {
        let storagePath = JanusFlow.memoKeyStoragePath()
        let publicPath  = JanusFlow.memoKeyPublicPath()

        if let anyOld <- account.storage.load<@AnyResource>(from: storagePath) {
            destroy anyOld
            account.capabilities.unpublish(publicPath)
        }

        let key <- JanusFlow.createMemoKey(pubkeyX: pubkeyX, pubkeyY: pubkeyY)
        account.storage.save(<- key, to: storagePath)

        let cap = account.capabilities.storage.issue<&{JanusFlow.MemoKeyPublic}>(storagePath)
        account.capabilities.publish(cap, at: publicPath)

        emit MemoKeyPublished(account: account.address, pubkeyX: pubkeyX, pubkeyY: pubkeyY)
    }

    // -----------------------------------------------------------------------
    // Admin resource
    // -----------------------------------------------------------------------

    access(all) resource Admin {
        // MAINNET-PREPARE-REMOVE
        access(all) fun resetCommitmentsForTestingOnly(account: Address) {
            JanusFT.commitments.remove(key: account)
        }
        // MAINNET-PREPARE-REMOVE
        access(all) fun resetTotalLockedForTestingOnly() {
            JanusFT.totalLocked = 0.0
            JanusFT.totalSupplyCommitment = Commitment(x: 0, y: 1)
            JanusFT.commitments = {}
        }

        access(all) fun initFees(recipient: Address, bps: UInt16, receiverPath: PublicPath) {
            let cfg = JanusFT.account.storage.borrow<&FeeConfig>(from: JanusFT.feeConfigStoragePath())
                ?? panic("JanusFT.initFees: FeeConfig not installed — call installFeeConfig() first")
            cfg.initialize(recipient: recipient, bps: bps, receiverPath: receiverPath)
            emit FeesInitialized(recipient: recipient, bps: bps)
        }

        access(all) fun setFeeBps(newBps: UInt16) {
            let cfg = JanusFT.account.storage.borrow<&FeeConfig>(from: JanusFT.feeConfigStoragePath())
                ?? panic("JanusFT.setFeeBps: FeeConfig not installed")
            let old = cfg.bps
            cfg.setBps(newBps)
            emit FeeBpsChanged(oldBps: old, newBps: newBps)
        }

        access(all) fun setFeeRecipient(newRecipient: Address) {
            let cfg = JanusFT.account.storage.borrow<&FeeConfig>(from: JanusFT.feeConfigStoragePath())
                ?? panic("JanusFT.setFeeRecipient: FeeConfig not installed")
            let old = cfg.recipient
            cfg.setRecipient(newRecipient)
            emit FeeRecipientChanged(oldRecipient: old, newRecipient: newRecipient)
        }

        access(all) fun setFeeReceiverPath(newPath: PublicPath) {
            let cfg = JanusFT.account.storage.borrow<&FeeConfig>(from: JanusFT.feeConfigStoragePath())
                ?? panic("JanusFT.setFeeReceiverPath: FeeConfig not installed")
            cfg.setReceiverPath(newPath)
        }

        // Kept from old Admin for backward compatibility (now renamed to setUnderlyingVaultType)
        access(all) fun setUnderlyingVaultType(typeIdentifier: String) {
            JanusFT.underlyingVaultTypeIdentifier = typeIdentifier
        }
    }

    // -----------------------------------------------------------------------
    // DEPRECATED STUBS (kept to satisfy upgrade validator for existing storage/types)
    // These were in the lab spike. In production, _babyAdd/_babySubtract replace them.
    // The names are preserved but they are NO LONGER CALLED by any code in v0.6.
    // -----------------------------------------------------------------------

    /// @deprecated — use _babyAdd (cross-VM) instead. Kept for upgrade compat.
    access(all) fun babyAddStub(a: Commitment, b: Commitment): Commitment {
        let p: UInt256 = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        let nx: UInt256 = (a.x + b.x + (a.y * b.y) % p) % p
        let ny: UInt256 = (a.y + b.y + (a.x * b.x) % p) % p
        return Commitment(x: nx, y: ny)
    }

    /// @deprecated — use _babyNegate (cross-VM) instead. Kept for upgrade compat.
    access(all) fun babyNegateStub(c: Commitment): Commitment {
        let p: UInt256 = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        let nx: UInt256 = p - c.x
        return Commitment(x: nx, y: c.y)
    }

    // -----------------------------------------------------------------------
    // Public factory functions
    // -----------------------------------------------------------------------

    /// Create a CommitmentRegistry with an empty vault of the configured underlying type.
    /// The caller must provide an empty vault of the correct underlying type.
    /// Use createRegistryWithVault(vault:) from the setup transaction instead.
    access(all) fun createRegistry(vault: @{FungibleToken.Vault}): @CommitmentRegistry {
        pre {
            vault.balance == 0.0:
                "JanusFT.createRegistry: vault must be empty"
            vault.getType() == self.custodyVaultType():
                "JanusFT.createRegistry: vault type mismatch — expected custodyVaultType"
        }
        return <- create CommitmentRegistry(vault: <- vault)
    }

    /// Legacy factory (from old contract) — kept for upgrade compat.
    /// In v0.6, prefer createRegistry() without args.
    access(all) fun createRegistryWithVault(vault: @{FungibleToken.Vault}): @CommitmentRegistry {
        return <- create CommitmentRegistry(vault: <- vault)
    }

    access(all) fun createAdmin(): @Admin {
        return <- create Admin()
    }

    // -----------------------------------------------------------------------
    // Public reader helpers
    // -----------------------------------------------------------------------

    access(all) fun balanceOfCommitment(account: Address): Commitment {
        return self.commitments[account] ?? Commitment(x: 0, y: 1)
    }

    access(all) view fun getTotalLocked(): UFix64 {
        return self.totalLocked
    }

    access(all) fun getTotalSupplyCommitment(): Commitment {
        return self.totalSupplyCommitment
    }

    access(all) view fun getUnderlyingVaultTypeIdentifier(): String {
        return self.underlyingVaultTypeIdentifier
    }

    // -----------------------------------------------------------------------
    // Init — PRESERVED from old contract (upgrade validator requires same init)
    //
    // NOTE: custodyVaultType is derived dynamically from underlyingVaultTypeIdentifier
    // via custodyVaultType() view fun. After upgrade, Admin.setUnderlyingVaultType()
    // must be called to set the correct typeIdentifier for the testnet MockFT vault:
    //   "A.7599043aea001283.MockFT.Vault"
    // -----------------------------------------------------------------------
    init() {
        self.AdminStoragePath               = /storage/janusFTAdmin
        self.CommitmentRegistryStoragePath  = /storage/janusFTRegistry
        self.CommitmentRegistryPublicPath   = /public/janusFTRegistry

        // Keep old default from lab spike (upgrade compat)
        self.underlyingVaultTypeIdentifier  = "A.7e60df042a9c0868.FlowToken.Vault"
        self.totalLocked                    = 0.0
        self.commitments                    = {}
        self.totalSupplyCommitment          = Commitment(x: 0, y: 1)

        self.account.storage.save(<- create Admin(), to: self.AdminStoragePath)
    }
}
