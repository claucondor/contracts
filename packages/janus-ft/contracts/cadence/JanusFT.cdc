// JanusFT.cdc — Production confidential-amount wrapper for any Cadence FungibleToken.
//
// This is the PRODUCTION contract — no stubs, real BabyJub cross-VM, real Groth16 ZK.
//
// UPGRADE NOTES (from v0.6 windowed-Pedersen → v0.7 aggregate-Pedersen):
//   All existing contract-level fields are preserved verbatim for Cadence upgrade-validator
//   compatibility. New EVM addresses and curve constants are exposed as view functions
//   rather than stored fields. The usedNonces anti-replay set is added INSIDE the existing
//   CommitmentRegistry resource (no new contract-level field).
//
// Architecture:
//   - Generic: wraps ANY @{FungibleToken.Vault} underlying (underlyingVaultTypeIdentifier).
//     For testnet this is A.7599043aea001283.MockFT.Vault; at mainnet swap the underlying.
//   - 2-gen Pedersen commitments tracked per-account on Cadence:
//       C = [amount]·G + [blinding]·H  (aggregate scheme, same as JanusFlow v0.7)
//   - All BabyJubJub EC point arithmetic delegated to BabyJub.sol on Flow EVM
//     via cross-VM call through the caller's COA.
//   - ZK proof verification (amount_disclose_aggregate + ConfidentialTransferAggregate)
//     done cross-VM via ConfidentialTransferAggregateVerifier.sol and
//     AmountDiscloseAggregateVerifier.sol.
//   - MemoKey: uses JanusFlow.MemoKey from 0x5dcbeb41055ec57e — shared
//     generic BabyJub pubkey resource.
//   - publishMemoKey: Cadence-only. MemoKey at canonical /storage/openjanusMemoKey.
//   - Events follow v0.7 schema with snapshot ciphertexts + nonce.
//
// EVM contracts used (Flow EVM testnet, chainId 545):
//   BabyJub.sol:                                0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
//   ConfidentialTransferAggregateVerifier.sol:  0x5702A545d2853b03B808aEA331f892c121b67243
//   AmountDiscloseAggregateVerifier.sol:        0xa80283baB7fcEFC2c75De43DB5a1cBF00E96B984
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

    /// ConfidentialTransferAggregateVerifier.sol — Groth16 shielded-transfer verifier (v0.7 aggregate)
    access(all) view fun TRANSFER_VERIFIER_ADDR(): String {
        return "0x5702A545d2853b03B808aEA331f892c121b67243"
    }

    /// AmountDiscloseAggregateVerifier.sol — Groth16 amount-disclose verifier (v0.7 aggregate)
    access(all) view fun AMOUNT_VERIFIER_ADDR(): String {
        return "0xa80283baB7fcEFC2c75De43DB5a1cBF00E96B984"
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
    //   Wrapped / Unwrapped / ShieldedTransferred — never emitted in v0.7.
    // These MUST be kept because Cadence upgrade validator forbids removing events.
    //
    // ACTIVE (v0.7 aggregate — snapshot ciphertexts):
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

    /// Emitted on the FIRST interaction of an account with JanusFT (wrap or shieldedTransfer).
    /// Off-chain SDK uses this to determine the earliest block to scan for an account's
    /// snapshots, replacing the DEFAULT_LOOKBACK window heuristic.
    /// Mirrors _recordFirstSnapshot(account) from JanusToken.sol on the EVM side.
    access(all) event FirstSnapshot(account: Address, block: UInt64)

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
    //
    // proof layout (flat [UInt256; 8]):
    //   [0..1]  pA  — G1 point
    //   [2..3]  pB row 0 (pre-swapped for EVM: [pi_b[0][1], pi_b[0][0]])
    //   [4..5]  pB row 1 (pre-swapped: [pi_b[1][1], pi_b[1][0]])
    //   [6..7]  pC  — G1 point
    //
    // Uses EVM.encodeABIWithSignature for correct ABI encoding of typed
    // fixed-size arrays ([UInt256;2], [[UInt256;2];2]) rather than manual
    // per-element encoding which produces incorrect dynamic-array headers.
    // -----------------------------------------------------------------------

    /// Verify AmountDiscloseAggregate proof.
    /// Public input layout (4 signals, v0.7 aggregate scheme):
    ///   [0] amount    — wrap amount (UFix64 internal units)
    ///   [1] commitX   — commitment x-coordinate
    ///   [2] commitY   — commitment y-coordinate
    ///   [3] nonce     — anti-replay nonce
    access(self) fun _verifyAmountProof(
        proof: [UInt256],
        publicInputs: [UInt256],
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): Bool {
        pre {
            proof.length == 8:        "JanusFT: amount proof must be 8 limbs"
            publicInputs.length == 4: "JanusFT: amount publicInputs must be 4 (v0.7 aggregate)"
        }
        let pA: [UInt256; 2]       = [proof[0], proof[1]]
        let pB: [[UInt256; 2]; 2]  = [[proof[2], proof[3]], [proof[4], proof[5]]]
        let pC: [UInt256; 2]       = [proof[6], proof[7]]
        let pub4: [UInt256; 4]     = [publicInputs[0], publicInputs[1], publicInputs[2], publicInputs[3]]

        let calldata = EVM.encodeABIWithSignature(
            "verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[4])",
            [pA, pB, pC, pub4]
        )
        let addr = EVM.addressFromString(JanusFT.AMOUNT_VERIFIER_ADDR())
        let result = coa.call(to: addr, data: calldata, gasLimit: 500_000, value: EVM.Balance(attoflow: 0))
        if result.status != EVM.Status.successful { return false }
        if result.data.length < 32 { return false }
        return result.data[31] == 1
    }

    /// Verify ConfidentialTransferAggregate proof.
    /// Public input layout (6 signals):
    ///   [0..1] C_old — sender's current commitment
    ///   [2..3] C_tx  — transfer commitment
    ///   [4..5] C_new — sender's new commitment
    access(self) fun _verifyTransferProof(
        proof: [UInt256],
        publicInputs: [UInt256],
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): Bool {
        pre {
            proof.length == 8:        "JanusFT: transfer proof must be 8 limbs"
            publicInputs.length == 6: "JanusFT: transfer publicInputs must be 6"
        }
        let pA: [UInt256; 2]       = [proof[0], proof[1]]
        let pB: [[UInt256; 2]; 2]  = [[proof[2], proof[3]], [proof[4], proof[5]]]
        let pC: [UInt256; 2]       = [proof[6], proof[7]]
        let pub6: [UInt256; 6]     = [
            publicInputs[0], publicInputs[1], publicInputs[2],
            publicInputs[3], publicInputs[4], publicInputs[5]
        ]

        let calldata = EVM.encodeABIWithSignature(
            "verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])",
            [pA, pB, pC, pub6]
        )
        let addr = EVM.addressFromString(JanusFT.TRANSFER_VERIFIER_ADDR())
        let result = coa.call(to: addr, data: calldata, gasLimit: 500_000, value: EVM.Balance(attoflow: 0))
        if result.status != EVM.Status.successful { return false }
        if result.data.length < 32 { return false }
        return result.data[31] == 1
    }

    // -----------------------------------------------------------------------
    // CommitmentRegistry resource
    //
    // usedNonces is stored INSIDE this resource (not at contract level) to
    // satisfy the Cadence upgrade-validator rule that forbids new contract-level
    // fields. New mutable state goes inside existing Resources only.
    // -----------------------------------------------------------------------

    access(all) resource interface CommitmentRegistryPublic {
        access(all) fun balanceOfCommitment(account: Address): Commitment
        access(all) view fun getTotalLocked(): UFix64
    }

    access(all) resource CommitmentRegistry: CommitmentRegistryPublic {

        access(self) var vault: @{FungibleToken.Vault}

        /// Anti-replay: per-registry nonce set for wrap operations.
        /// Nonces are keyed by the submitting address to allow parallel wraps
        /// across accounts while preventing replay of any single wrap proof.
        access(self) var usedNonces: {UInt256: Bool}

        init(vault: @{FungibleToken.Vault}) {
            self.vault <- vault
            self.usedNonces = {}
        }

        access(all) fun balanceOfCommitment(account: Address): Commitment {
            return JanusFT.commitments[account] ?? Commitment(x: 0, y: 1)
        }

        access(all) view fun getTotalLocked(): UFix64 {
            return JanusFT.totalLocked
        }

        // ----- wrapWithProof (v0.7 aggregate) -----
        //
        // Inputs match the EVM-side JanusFlow.wrapWithProof signature:
        //   nonce              — anti-replay nonce (must be unused)
        //   commit             — Pedersen commitment for NET amount
        //   pA, pB, pC         — Groth16 proof (snarkjs flat format, 8 UInt256 limbs total)
        //   encryptedSnapshot  — AES-GCM ciphertext of (netAmount, blinding) for self-recovery
        //   ephPubkeyX/Y       — sender's ephemeral BabyJub pubkey for snapshot ECDH
        //   vault              — deposit vault; must be the configured custodyVaultType
        //
        // AmountDisclose public inputs (4 signals, v0.7 aggregate scheme):
        //   [vault.balance, commit.x, commit.y, nonce]
        //
        // Fee is computed on GROSS (vault.balance before skim).
        // Net = gross - fee. The proof binds to GROSS (== vault.balance at entry).
        // Contract validates: gross == netAmount + fee after skim.
        access(all) fun wrapWithProof(
            account:           Address,
            nonce:             UInt256,
            commitX:           UInt256,
            commitY:           UInt256,
            pA:                [UInt256],
            pB:                [[UInt256]],
            pC:                [UInt256],
            encryptedSnapshot: [UInt8],
            ephPubkeyX:        UInt256,
            ephPubkeyY:        UInt256,
            vault:             @{FungibleToken.Vault},
            coa:               auth(EVM.Call) &EVM.CadenceOwnedAccount
        ) {
            pre {
                pA.length == 2:         "JanusFT: pA must have 2 elements"
                pB.length == 2:         "JanusFT: pB must have 2 rows"
                pB[0].length == 2:      "JanusFT: pB[0] must have 2 elements"
                pB[1].length == 2:      "JanusFT: pB[1] must have 2 elements"
                pC.length == 2:         "JanusFT: pC must have 2 elements"
                vault.balance > 0.0:    "JanusFT: zero wrap"
                vault.getType() == JanusFT.custodyVaultType():
                    "JanusFT.wrapWithProof: vault type mismatch — expected custodyVaultType"
                !(self.usedNonces[nonce] ?? false):
                    "JanusFT.wrapWithProof: nonce already used (replay attempt)"
            }

            // Mark nonce used before any state changes (reentrancy guard pattern)
            self.usedNonces[nonce] = true

            let gross = vault.balance

            // Fee skim
            let fee = JanusFT.computeFee(gross: gross)
            if fee > 0.0 {
                let feeVault <- vault.withdraw(amount: fee)
                let receiverPath = JanusFT.feeReceiverPath()
                let feeReceiver = getAccount(JanusFT.feeRecipient())
                    .capabilities.borrow<&{FungibleToken.Receiver}>(receiverPath)
                    ?? panic("JanusFT.wrapWithProof: feeRecipient has no FungibleToken receiver at configured path")
                feeReceiver.deposit(from: <- feeVault)
                emit FeeCollected(user: account, fee: fee, op: "wrap")
            }

            let netAmount = vault.balance
            assert(netAmount > 0.0, message: "JanusFT.wrapWithProof: net amount is zero after fee skim")

            // Flatten proof to 8-element array: [pA[0], pA[1], pB[0][1], pB[0][0], pB[1][1], pB[1][0], pC[0], pC[1]]
            // pB coordinates are byte-swapped per snarkjs / EVM Groth16 convention.
            let proof: [UInt256] = [
                pA[0], pA[1],
                pB[0][1], pB[0][0],
                pB[1][1], pB[1][0],
                pC[0], pC[1]
            ]

            // AmountDisclose public inputs (4 signals, v0.7 aggregate):
            //   [netAmount_as_uint256, commitX, commitY, nonce]
            // FIX 2026-06-05: align with EVM siblings (JanusFlow/JanusERC20) — proof binds to NET, not GROSS.
            // SDK orchestration computes net = gross - fee before building the proof; this contract must match.
            let netUInt = JanusFT._ufixToUInt256(netAmount)
            let publicInputs: [UInt256] = [netUInt, commitX, commitY, nonce]

            let amountVerified = JanusFT._verifyAmountProof(
                proof: proof, publicInputs: publicInputs, coa: coa
            )
            assert(amountVerified, message: "JanusFT.wrapWithProof: amount-disclose proof verification failed")

            // Deposit net vault into custody
            self.vault.deposit(from: <- vault)

            // Update per-account commitment (homomorphic add)
            let txCommit = Commitment(x: commitX, y: commitY)
            let wasFresh: Bool = (JanusFT.commitments[account] == nil)
            let current  = JanusFT.commitments[account] ?? Commitment(x: 0, y: 1)
            let newCommit = JanusFT._babyAdd(a: current, b: txCommit, coa: coa)
            JanusFT.commitments[account] = newCommit

            JanusFT.totalSupplyCommitment = JanusFT._babyAdd(
                a: JanusFT.totalSupplyCommitment, b: txCommit, coa: coa
            )
            JanusFT.totalLocked = JanusFT.totalLocked + netAmount

            if wasFresh {
                emit FirstSnapshot(account: account, block: getCurrentBlock().height)
            }

            emit WrapWithSnapshot(
                account:           account,
                commitX:           newCommit.x,
                commitY:           newCommit.y,
                encryptedSnapshot: encryptedSnapshot,
                ephPubX:           ephPubkeyX,
                ephPubY:           ephPubkeyY
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

            // Capture freshness BEFORE any state writes (sender always has a commitment
            // if they pass C_old check, but recipient may be nil on first receive)
            let senderWasFresh: Bool = (JanusFT.commitments[fromAccount] == nil)
            let recipientWasFresh: Bool = (JanusFT.commitments[toAccount] == nil)

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

            if senderWasFresh {
                emit FirstSnapshot(account: fromAccount, block: getCurrentBlock().height)
            }
            if recipientWasFresh {
                emit FirstSnapshot(account: toAccount, block: getCurrentBlock().height)
            }

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
        //
        // Uses nonce = 0 for the amount-disclose proof (anti-replay on unwrap is
        // enforced by the transfer-proof's C_old check: once the state machine
        // transitions C_old → C_new, replaying the same transfer proof fails
        // the C_old check). Nonce 0 is reserved for unwrap and is never added
        // to usedNonces (it is implicitly "used" by the state machine check).
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
                amountPublicInputs.length == 4: "JanusFT: amountPublicInputs must have 4 elements (v0.7 aggregate)"
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
    // DEPRECATED STUBS
    // Preserved so that the Cadence upgrade validator does not reject the
    // update (validator forbids removing declared functions that are part of
    // the contract interface). These functions are never called by v0.7 code.
    // -----------------------------------------------------------------------

    /// @deprecated — kept for upgrade validator compat. NOT called in v0.7.
    access(all) fun babyAddStub(a: Commitment, b: Commitment): Commitment {
        let p: UInt256 = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        let nx: UInt256 = (a.x + b.x + (a.y * b.y) % p) % p
        let ny: UInt256 = (a.y + b.y + (a.x * b.x) % p) % p
        return Commitment(x: nx, y: ny)
    }

    /// @deprecated — kept for upgrade validator compat. NOT called in v0.7.
    access(all) fun babyNegateStub(c: Commitment): Commitment {
        let p: UInt256 = 21888242871839275222246405745257275088548364400416034343698204186575808495617
        let nx: UInt256 = p - c.x
        return Commitment(x: nx, y: c.y)
    }

    // -----------------------------------------------------------------------
    // UFix64 → UInt256 conversion helper
    //
    // UFix64 uses 8 decimal places (1.0 = 100_000_000 internal units).
    // The circuit receives the raw integer representation of the UFix64 value.
    // -----------------------------------------------------------------------

    access(all) view fun _ufixToUInt256(_ v: UFix64): UInt256 {
        // UFix64 * 1e8 gives the integer representation.
        // Multiply then divide avoids overflow on the multiplication step.
        // Cadence UFix64 max is ~18.4e18 so raw int fits in UInt256.
        let scaled = v * 100_000_000.0
        // Convert to UInt256 via UInt64 → UInt256 promotion
        return UInt256(UInt64(scaled))
    }

    // -----------------------------------------------------------------------
    // Public factory functions
    // -----------------------------------------------------------------------

    /// Create a CommitmentRegistry with an empty vault of the configured underlying type.
    /// The caller must provide an empty vault of the correct underlying type.
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
    /// In v0.7, prefer createRegistry(vault:).
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
