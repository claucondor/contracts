/// JanusFlow_stub.cdc — Minimal stub of JanusFlow for Cadence unit test environments.
///
/// JanusFT imports JanusFlow for MemoKey operations.  On the Flow emulator test
/// environment, the real JanusFlow contract (deployed at 0x5dcbeb41055ec57e on testnet)
/// is not available.  This stub provides the exact interface surface that JanusFT uses
/// so the contract can be deployed in `flow test` without the full JanusFlow dependency.
///
/// Stubbed surface:
///   - MemoKeyPublic interface (getPubkeyX, getPubkeyY)
///   - MemoKey resource
///   - memoKeyStoragePath() — returns /storage/openjanusMemoKey
///   - memoKeyPublicPath()  — returns /public/openjanusMemoKey
///   - createMemoKey(pubkeyX:pubkeyY:) — creates a @MemoKey resource
///
/// NOT stubbed (not used by JanusFT):
///   - Any EVM cross-VM functionality
///   - JanusFlow token operations
///
/// TESTNET-ONLY STUB — never deploy to mainnet or production networks.

access(all) contract JanusFlow {

    // -----------------------------------------------------------------------
    // MemoKey public interface
    // -----------------------------------------------------------------------

    access(all) resource interface MemoKeyPublic {
        access(all) view fun getPubkeyX(): UInt256
        access(all) view fun getPubkeyY(): UInt256
    }

    // -----------------------------------------------------------------------
    // MemoKey resource
    // -----------------------------------------------------------------------

    access(all) resource MemoKey: MemoKeyPublic {
        access(all) let pubkeyX: UInt256
        access(all) let pubkeyY: UInt256

        init(pubkeyX: UInt256, pubkeyY: UInt256) {
            self.pubkeyX = pubkeyX
            self.pubkeyY = pubkeyY
        }

        access(all) view fun getPubkeyX(): UInt256 {
            return self.pubkeyX
        }

        access(all) view fun getPubkeyY(): UInt256 {
            return self.pubkeyY
        }
    }

    // -----------------------------------------------------------------------
    // Canonical storage / public paths (match production JanusFlow)
    // -----------------------------------------------------------------------

    access(all) fun memoKeyStoragePath(): StoragePath {
        return /storage/openjanusMemoKey
    }

    access(all) fun memoKeyPublicPath(): PublicPath {
        return /public/openjanusMemoKey
    }

    // -----------------------------------------------------------------------
    // Factory
    // -----------------------------------------------------------------------

    access(all) fun createMemoKey(pubkeyX: UInt256, pubkeyY: UInt256): @MemoKey {
        return <- create MemoKey(pubkeyX: pubkeyX, pubkeyY: pubkeyY)
    }

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------

    init() {}
}
