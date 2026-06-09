// JanusFlow.cdc — Cadence wrapper for JanusToken ElGamal accumulator
//
// Architecture:
//   Cadence manages FLOW vault custody.
//   EVM (JanusToken) manages encrypted balance accounting.
//   Cross-VM calls via each user's own COA.
//
// Key insight (per-user COA pattern):
//   Each user has their own COA at /storage/evm.
//   The COA's EVM address is that user's msg.sender in JanusToken.
//   This means JanusToken.locked[coa.address()] tracks per-user FLOW.
//   NO shared COA — every user is independently sovereign.
//
// Operations:
//   wrap()                 — deposit FLOW + encrypt ciphertext to recipient's slot
//   confidentialTransfer() — transfer encrypted ciphertext (no FLOW moves)
//   unwrap()               — prove decryption + release FLOW to recipient
//   registerPubkey()       — register BabyJub pubkey via COA
//   commitRotation()       — start pubkey rotation
//   finalizeRotation()     — complete pubkey rotation after timelock
//
// Privacy properties:
//   - Recipient learns total only, not per-sender breakdown
//   - Sender-recipient pairing visible on-chain by design
//   - Wrap/unwrap amounts visible via EVM Transfer events (unavoidable)
//   - IND-CPA under DDH on BabyJubJub
//
// Deployed at: 0x28fef3d1d6a12800 (openjanus testnet account)
// EVM target:  JanusToken at [set after EVM deploy]

import "EVM"
import "FlowToken"
import "FungibleToken"

access(all) contract JanusFlow {

    // ─── Constants ──────────────────────────────────────────────────────────

    /// JanusToken EVM contract address (set at deploy time)
    access(self) var janusToken: EVM.EVMAddress

    /// BabyJub.sol EVM address (reused from phase 1)
    access(all) let babyJubEVM: EVM.EVMAddress

    // ─── State ──────────────────────────────────────────────────────────────

    /// Total FLOW locked in this contract (across all users)
    access(self) var totalLocked: UFix64

    // ─── Events ─────────────────────────────────────────────────────────────

    access(all) event Wrapped(
        from: Address,
        toEVM: String,
        amountFlow: UFix64,
        nonce: UInt256
    )

    access(all) event ConfidentialTransfer(
        from: Address,
        fromEVM: String,
        toEVM: String,
        transferAmountAttoFlow: UInt256,
        nonce: UInt256
    )

    access(all) event Unwrapped(
        from: Address,
        fromEVM: String,
        recipient: Address,
        amountFlow: UFix64
    )

    access(all) event PubkeyRegistered(
        account: Address,
        evmAddress: String,
        pkX: String,
        pkY: String
    )

    access(all) event RotationCommitted(account: Address, evmAddress: String)
    access(all) event RotationFinalized(account: Address, evmAddress: String)

    // ─── ABI encoding helpers ────────────────────────────────────────────────
    //
    // All calldata is ABI-encoded off-chain by the TypeScript SDK and passed
    // as [UInt8] hex arrays. The Cadence contract just forwards the calldata
    // to JanusToken via the user's COA. This avoids reimplementing ABI
    // encoding in Cadence (which is error-prone and gas-expensive).

    // ─── Public functions ────────────────────────────────────────────────────

    /// Register a BabyJubJub public key for msg.sender's COA.
    /// @param signer        The Flow account (must have COA at /storage/evm)
    /// @param calldataHex   ABI-encoded calldata for registerPubkey(uint256,uint256)
    access(all) fun registerPubkey(
        signer: auth(BorrowValue) &Account,
        calldataHex: String
    ) {
        let coa = JanusFlow._borrowCOA(signer: signer)
        let evmAddr = coa.address().toString()

        let result = coa.call(
            to: self.janusToken,
            data: calldataHex.decodeHex(),
            gasLimit: 200_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "JanusFlow.registerPubkey failed: ".concat(result.errorMessage)
        )

        emit PubkeyRegistered(
            account: signer.address,
            evmAddress: evmAddr,
            pkX: "",
            pkY: ""
        )
    }

    /// Wrap FLOW into a confidential slot for a recipient.
    /// @param signer         The sending Flow account (their COA will be msg.sender)
    /// @param vault          FLOW to lock (must be > 0)
    /// @param toEVMHex       Recipient's EVM address (hex, with 0x prefix)
    /// @param senderNonce    Sender's current nonce (must match on-chain)
    /// @param calldataHex    Pre-encoded calldata for wrap(...) — all args except msg.value
    access(all) fun wrap(
        signer: auth(BorrowValue) &Account,
        vault: @FlowToken.Vault,
        toEVMHex: String,
        senderNonce: UInt256,
        calldataHex: String
    ) {
        let amount = vault.balance
        assert(amount > 0.0, message: "JanusFlow.wrap: zero amount")

        let coa = JanusFlow._borrowCOA(signer: signer)

        // Convert UFix64 FLOW to attoFLOW (1 FLOW = 1e18 attoFLOW)
        // UFix64 has 8 decimal places: amount * 1e8 gives integer FLOW-units,
        // then * 1e10 gives attoFLOW. EVM.Balance requires UInt.
        let flowUnits: UInt64 = UInt64(amount * 100_000_000.0)
        let attoflow: UInt = UInt(flowUnits) * 10_000_000_000

        // Deposit FLOW to contract's vault
        JanusFlow._depositToVault(vault: <-vault)

        // Call JanusToken.wrap() with msg.value = attoflow
        let result = coa.call(
            to: self.janusToken,
            data: calldataHex.decodeHex(),
            gasLimit: 400_000,
            value: EVM.Balance(attoflow: attoflow)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "JanusFlow.wrap EVM call failed: ".concat(result.errorMessage)
        )

        self.totalLocked = self.totalLocked + amount

        emit Wrapped(
            from: signer.address,
            toEVM: toEVMHex,
            amountFlow: amount,
            nonce: senderNonce
        )
    }

    /// Confidential transfer: reassign locked FLOW + accumulate ciphertext.
    /// No FLOW moves out of the contract; only the EVM accounting changes.
    /// @param signer           The sending Flow account
    /// @param toEVMHex         Recipient's EVM address
    /// @param transferAmount   Amount in attoFLOW to reassign
    /// @param senderNonce      Sender's current nonce
    /// @param calldataHex      Pre-encoded calldata for confidentialTransfer(...)
    access(all) fun confidentialTransfer(
        signer: auth(BorrowValue) &Account,
        toEVMHex: String,
        transferAmount: UInt256,
        senderNonce: UInt256,
        calldataHex: String
    ) {
        let coa = JanusFlow._borrowCOA(signer: signer)
        let evmAddr = coa.address().toString()

        let result = coa.call(
            to: self.janusToken,
            data: calldataHex.decodeHex(),
            gasLimit: 600_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "JanusFlow.confidentialTransfer failed: ".concat(result.errorMessage)
        )

        emit ConfidentialTransfer(
            from: signer.address,
            fromEVM: evmAddr,
            toEVM: toEVMHex,
            transferAmountAttoFlow: transferAmount,
            nonce: senderNonce
        )
    }

    /// Unwrap: verify decrypt_open ZK proof + release FLOW to recipient.
    /// @param signer        The caller (must be slot owner)
    /// @param amount        Claimed total in slot (in UFix64 FLOW)
    /// @param recipient     Flow address to receive unwrapped FLOW
    /// @param calldataHex   Pre-encoded calldata for unwrap(amount, recipient, publicInputs, proof)
    access(all) fun unwrap(
        signer: auth(BorrowValue) &Account,
        amount: UFix64,
        recipient: Address,
        calldataHex: String
    ) {
        assert(amount > 0.0, message: "JanusFlow.unwrap: zero amount")
        assert(
            amount <= self.totalLocked,
            message: "JanusFlow.unwrap: amount exceeds total locked"
        )

        let coa = JanusFlow._borrowCOA(signer: signer)
        let evmAddr = coa.address().toString()

        // Call JanusToken.unwrap() — EVM will verify proof + deduct locked[coa]
        // Note: the EVM contract sends attoFLOW to the contract address itself
        // (since the contract holds the vault), not directly to recipient.
        // After the EVM call, we release from the Cadence vault.
        let result = coa.call(
            to: self.janusToken,
            data: calldataHex.decodeHex(),
            gasLimit: 600_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "JanusFlow.unwrap EVM call failed: ".concat(result.errorMessage)
        )

        // Release FLOW from our vault to recipient
        JanusFlow._releaseFromVault(recipient: recipient, amount: amount)
        self.totalLocked = self.totalLocked - amount

        emit Unwrapped(
            from: signer.address,
            fromEVM: evmAddr,
            recipient: recipient,
            amountFlow: amount
        )
    }

    /// Commit a pubkey rotation (starts timelock).
    access(all) fun commitRotation(
        signer: auth(BorrowValue) &Account,
        calldataHex: String
    ) {
        let coa = JanusFlow._borrowCOA(signer: signer)
        let evmAddr = coa.address().toString()

        let result = coa.call(
            to: self.janusToken,
            data: calldataHex.decodeHex(),
            gasLimit: 100_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "JanusFlow.commitRotation failed: ".concat(result.errorMessage)
        )

        emit RotationCommitted(account: signer.address, evmAddress: evmAddr)
    }

    /// Finalize a pubkey rotation (only works after timelock has elapsed).
    access(all) fun finalizeRotation(
        signer: auth(BorrowValue) &Account,
        calldataHex: String
    ) {
        let coa = JanusFlow._borrowCOA(signer: signer)
        let evmAddr = coa.address().toString()

        let result = coa.call(
            to: self.janusToken,
            data: calldataHex.decodeHex(),
            gasLimit: 100_000,
            value: EVM.Balance(attoflow: 0)
        )
        assert(
            result.status == EVM.Status.successful,
            message: "JanusFlow.finalizeRotation failed: ".concat(result.errorMessage)
        )

        emit RotationFinalized(account: signer.address, evmAddress: evmAddr)
    }

    // ─── View functions ──────────────────────────────────────────────────────

    access(all) fun getTotalLocked(): UFix64 {
        return self.totalLocked
    }

    access(all) fun getJanusTokenAddress(): String {
        return self.janusToken.toString()
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    access(self) fun _borrowCOA(signer: auth(BorrowValue) &Account): auth(EVM.Call) &EVM.CadenceOwnedAccount {
        return signer.storage
            .borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(from: /storage/evm)
            ?? panic("JanusFlow: no COA at /storage/evm — call EVM.createCadenceOwnedAccount() first")
    }

    /// Internal vault for FLOW custody.
    /// The vault lives in contract storage. In production, use a capability-based
    /// resource pattern. For testnet, we keep this simple.
    access(self) fun _depositToVault(vault: @FlowToken.Vault) {
        let contractVault = self.account.storage
            .borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/janusFlowVault)
            ?? panic("JanusFlow: vault not initialized")
        contractVault.deposit(from: <-vault)
    }

    access(self) fun _releaseFromVault(recipient: Address, amount: UFix64) {
        let contractVault = self.account.storage
            .borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/janusFlowVault)
            ?? panic("JanusFlow: vault not initialized")

        let withdrawVault <- contractVault.withdraw(amount: amount) as! @FlowToken.Vault

        let recipientRef = getAccount(recipient)
            .capabilities
            .borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic("JanusFlow: recipient has no FlowToken receiver")

        recipientRef.deposit(from: <-withdrawVault)
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    init(janusTokenHex: String, babyJubHex: String) {
        self.janusToken = EVM.addressFromString(janusTokenHex)
        self.babyJubEVM = EVM.addressFromString(babyJubHex)
        self.totalLocked = 0.0

        // Initialize the FLOW vault for custody
        let vault <- FlowToken.createEmptyVault(vaultType: Type<@FlowToken.Vault>())
        self.account.storage.save(<-vault, to: /storage/janusFlowVault)
    }
}
