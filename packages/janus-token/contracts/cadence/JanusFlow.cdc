// JanusFlow.cdc — MemoKey registry + legacy storage compatibility shim
//
// v0.6 architecture: the Cadence cross-VM router pattern is retired.
// The v0.6 SDK calls the EVM JanusFlow proxy directly from client-side
// Cadence transactions; this contract no longer routes anything.
//
// What this contract still provides:
//   MemoKey Resource type + MemoKeyPublic interface — generic BabyJub pubkey
//   store. JanusFT and any other JanusFlow privacy app imports this type
//   so each app does not need to define its own keypair store.
//   createMemoKey(pubkeyX, pubkeyY) factory.
//   MemoKeyPublished event + getMemoPubkey(owner) view.
//
// Storage compatibility (fields that cannot be removed):
//   All contract-level fields from v0.3 are preserved because Cadence
//   upgrades cannot remove fields that are already initialized in production
//   storage. These fields are inert: totalLocked, commitments, pubkeys,
//   janusTokenEVM, activeImpl, paused, pendingImplVersion, pendingImplUnlockAt.
//
// Admin model: capability-based AdminResource (pause/unpause only).
//
// Deployed at: 5dcbeb41055ec57e (openjanus-janusflow-router account)

import "EVM"

access(all) contract JanusFlow {

    // ─── Storage Paths ──────────────────────────────────────────────────────────

    access(all) let AdminStoragePath: StoragePath

    // ─── State — Inert storage-compatibility fields ──────────────────────────────
    // All fields below are preserved ONLY because Cadence upgrades cannot remove
    // fields that were set during the original contract init. They are never
    // written or read by any live code path in v0.6+.

    access(self) var totalLocked: UFix64
    access(self) var commitments: {Address: [UInt8]}
    access(self) var pubkeys: {Address: [UInt8]}

    /// Legacy EVM target set at deploy time (v0.2.1). Storage-compat only.
    access(self) let janusTokenEVM: EVM.EVMAddress

    access(self) var activeImpl: String
    access(self) var paused: Bool
    access(self) var pendingImplVersion: String?
    access(self) var pendingImplUnlockAt: UFix64

    // ─── Events ─────────────────────────────────────────────────────────────────
    // All events from prior versions are kept because Cadence upgrades cannot
    // remove event declarations once deployed.

    access(all) event Wrapped(
        depositor: Address,
        amountFlow: UFix64,
        toEVMHex: String
    )
    access(all) event ShieldedTransferred(
        from: Address,
        toEVMHex: String
    )
    access(all) event Unwrapped(
        from: Address,
        recipient: Address,
        amountFlow: UFix64
    )
    access(all) event ConfidentialTransferred(
        from: Address,
        to: Address,
        transferAmountAttoFlow: UInt256
    )
    access(all) event PubkeyRegistered(account: Address)
    access(all) event Paused()
    access(all) event Unpaused()
    access(all) event ImplSwapProposed(pendingVersion: String, unlockAt: UFix64)
    access(all) event ImplSwapped(oldVersion: String, newVersion: String)
    access(all) event ImplSwapCancelled()
    access(all) event AdminSlotReset(
        target: Address,
        targetEVMHex: String
    )

    /// v0.5.2 — Emitted when a user publishes (or rotates) their memo pubkey.
    access(all) event MemoKeyPublished(
        owner: Address,
        pubkeyX: UInt256,
        pubkeyY: UInt256
    )

    // ─── MemoKey Resource ────────────────────────────────────────────────────────
    //
    // Generic BabyJub pubkey store. Any JanusFlow privacy app (PrivateTip,
    // JanusFT, etc.) imports this type instead of defining its own.
    //
    // Storage layout (per user):
    //   /storage/openjanusMemoKey  — &MemoKey (private; owner borrows)
    //   /public/openjanusMemoKey   — &{MemoKeyPublic} (read-only pubkey for senders)
    //
    // The privkey is NEVER passed to chain. Derivation is client-side only.

    /// Read-only interface for the public capability.
    access(all) resource interface MemoKeyPublic {
        access(all) view fun getPubkeyX(): UInt256
        access(all) view fun getPubkeyY(): UInt256
    }

    /// BabyJub pubkey store. Privkey stays off-chain forever.
    access(all) resource MemoKey: MemoKeyPublic {
        access(self) let pubkeyX: UInt256
        access(self) let pubkeyY: UInt256

        init(pubkeyX: UInt256, pubkeyY: UInt256) {
            self.pubkeyX = pubkeyX
            self.pubkeyY = pubkeyY
        }

        access(all) view fun getPubkeyX(): UInt256 { return self.pubkeyX }
        access(all) view fun getPubkeyY(): UInt256 { return self.pubkeyY }
    }

    /// Canonical MemoKey storage path (all JanusFlow apps use this).
    access(all) view fun memoKeyStoragePath(): StoragePath {
        return /storage/openjanusMemoKey
    }

    /// Canonical MemoKey public capability path.
    access(all) view fun memoKeyPublicPath(): PublicPath {
        return /public/openjanusMemoKey
    }

    /// Factory: mint a fresh MemoKey resource (pubkey only).
    access(all) fun createMemoKey(
        pubkeyX: UInt256,
        pubkeyY: UInt256
    ): @MemoKey {
        return <- create MemoKey(pubkeyX: pubkeyX, pubkeyY: pubkeyY)
    }

    /// View function: read another account's published memo pubkey.
    /// Returns nil if no MemoKey capability is published at the canonical path.
    access(all) fun getMemoPubkey(owner: Address): {String: UInt256}? {
        let acct = getAccount(owner)
        if let cap = acct.capabilities.borrow<&{MemoKeyPublic}>(self.memoKeyPublicPath()) {
            return {"x": cap.getPubkeyX(), "y": cap.getPubkeyY()}
        }
        return nil
    }

    // ─── Admin Resource ──────────────────────────────────────────────────────────

    access(all) resource AdminResource {

        access(all) fun pause() {
            JanusFlow.paused = true
            emit Paused()
        }

        access(all) fun unpause() {
            JanusFlow.paused = false
            emit Unpaused()
        }
    }

    // ─── View Functions ──────────────────────────────────────────────────────────

    access(all) view fun isPaused(): Bool {
        return self.paused
    }

    access(all) view fun getActiveImplVersion(): String {
        return self.activeImpl
    }

    access(all) view fun getPendingImplVersion(): String? {
        return self.pendingImplVersion
    }

    access(all) view fun getPendingImplUnlockAt(): UFix64 {
        return self.pendingImplUnlockAt
    }

    access(all) view fun getTotalLocked(): UFix64 {
        return self.totalLocked
    }

    /// LEGACY (v0.2.1): always nil in v0.3+ (commitments live on EVM).
    access(all) view fun getCommitment(user: Address): [UInt8]? {
        return self.commitments[user]
    }

    /// LEGACY (v0.2.1): always nil in v0.3+.
    access(all) view fun getPubkey(user: Address): [UInt8]? {
        return self.pubkeys[user]
    }

    /// LEGACY (v0.2.1): always false in v0.3+.
    access(all) view fun hasCommitment(user: Address): Bool {
        return self.commitments[user] != nil
    }

    // ─── Initializer ─────────────────────────────────────────────────────────────

    init(janusTokenHex: String) {
        self.AdminStoragePath = /storage/janusFlowAdmin

        // janusTokenEVM kept for storage compatibility only.
        self.janusTokenEVM = EVM.addressFromString(janusTokenHex)

        self.totalLocked = 0.0
        self.commitments = {}
        self.pubkeys = {}
        self.paused = false
        self.activeImpl = "0.3.0"
        self.pendingImplVersion = nil
        self.pendingImplUnlockAt = 0.0

        self.account.storage.save(
            <-create AdminResource(),
            to: self.AdminStoragePath
        )
    }
}
