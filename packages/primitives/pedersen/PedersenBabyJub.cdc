// PedersenBabyJub.cdc — cross-VM Pedersen commitments on BabyJubJub
//
// Cadence contract wrapping BabyJub.sol via Flow cross-VM.
// Provides homomorphic point operations for always-private confidential balances.
//
// ---------------------------------------------------------------------------
// ARCHITECTURE
// ---------------------------------------------------------------------------
//
// Commitments are ALWAYS computed off-chain using @iden3/circomlibjs
// buildPedersenHash. This contract provides only point operations:
//   addCommits, subCommits, negate, identity, isIdentity
//
// Homomorphic property:
//   addCommits(commit(a, r1), commit(b, r2)) = commit(a+b, r1+r2)
//
// Cross-VM cost model:
//   BabyAdd via pure Cadence: ~47,800 CU (exceeds 9,999 CU tx limit)
//   BabyAdd via EVM cross-VM:  ~16 CU dispatch + ~34,511 EVM gas (viable)
//
// ---------------------------------------------------------------------------
// DEPLOYED ADDRESSES
// ---------------------------------------------------------------------------
//
//   PedersenBabyJub.cdc  (Cadence testnet):  0x7599043aea001283
//   BabyJub.sol          (EVM testnet):       0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
//
// ---------------------------------------------------------------------------
// SECURITY
// ---------------------------------------------------------------------------
//
// EXPERIMENTAL. Not audited. Do not use with real funds.
// The Admin resource allows updating the BabyJub.sol address post-deploy
// without redeployment (for migrating to future addresses).
//
// ---------------------------------------------------------------------------

import "EVM"

access(all) contract PedersenBabyJub {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// BN254 base field prime p (= BabyJubJub's field prime).
    access(all) let BN254_P: UInt256

    /// BabyJubJub curve parameters (twisted Edwards form).
    access(all) let BABYJUB_A: UInt256  // 168700
    access(all) let BABYJUB_D: UInt256  // 168696

    /// Generator point BASE8 (8 * standard generator, used by circomlib Pedersen).
    access(all) let BASE8_X: UInt256
    access(all) let BASE8_Y: UInt256

    /// Identity element: (0, 1) — neutral element for BabyJubJub addition.
    access(all) let IDENTITY_X: UInt256  // 0
    access(all) let IDENTITY_Y: UInt256  // 1

    /// EVM address of the deployed BabyJub.sol helper on Flow EVM.
    /// Updatable via Admin.setHelperAddr() without contract redeployment.
    access(all) var BABYJUB_HELPER_ADDR: String

    // -----------------------------------------------------------------------
    // Function selectors (pre-computed keccak256 snippets)
    // -----------------------------------------------------------------------

    /// babyAdd(uint256,uint256,uint256,uint256) = 0xa54a0868
    access(self) let SEL_BABY_ADD: [UInt8]

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    access(all) event HelperAddressUpdated(oldAddr: String, newAddr: String)

    // -----------------------------------------------------------------------
    // Core point operations (cross-VM)
    // -----------------------------------------------------------------------

    /// addCommits — homomorphic addition of two BabyJubJub commitments.
    ///
    /// Computes c1 + c2 on BabyJubJub by calling BabyJub.sol via cross-VM.
    ///
    /// Homomorphic property:
    ///   addCommits(commit(a, r1), commit(b, r2)) = commit(a+b, r1+r2)
    ///
    /// Cost: ~16 CU Cadence + ~34,511 EVM gas
    ///
    access(all) fun addCommits(
        c1: {String: UInt256},
        c2: {String: UInt256},
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): {String: UInt256} {
        let c1x = c1["x"] ?? panic("c1 missing key 'x'")
        let c1y = c1["y"] ?? panic("c1 missing key 'y'")
        let c2x = c2["x"] ?? panic("c2 missing key 'x'")
        let c2y = c2["y"] ?? panic("c2 missing key 'y'")

        return self._babyAddViaEVM(c1x: c1x, c1y: c1y, c2x: c2x, c2y: c2y, coa: coa)
    }

    /// subCommits — homomorphic subtraction: c1 - c2 = c1 + negate(c2).
    ///
    /// Negation is computed Cadence-side (trivial: (-x mod p, y)).
    /// Then addCommits is called once via cross-VM.
    ///
    /// Typical use: new_sender_balance = subCommits(old_balance, transfer_commit)
    ///
    access(all) fun subCommits(
        c1: {String: UInt256},
        c2: {String: UInt256},
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): {String: UInt256} {
        let c1x = c1["x"] ?? panic("c1 missing key 'x'")
        let c1y = c1["y"] ?? panic("c1 missing key 'y'")
        let c2x = c2["x"] ?? panic("c2 missing key 'x'")
        let c2y = c2["y"] ?? panic("c2 missing key 'y'")

        // Negate c2 Cadence-side: -(x, y) = (p - x, y)
        let neg = PedersenBabyJub._negateCoords(x: c2x, y: c2y)

        return self._babyAddViaEVM(
            c1x: c1x, c1y: c1y,
            c2x: neg["x"]!, c2y: neg["y"]!,
            coa: coa
        )
    }

    // -----------------------------------------------------------------------
    // Pure Cadence helpers (no EVM call)
    // -----------------------------------------------------------------------

    /// identity — returns the neutral element (0, 1) of BabyJubJub.
    access(all) view fun identity(): {String: UInt256} {
        return {"x": self.IDENTITY_X, "y": self.IDENTITY_Y}
    }

    /// negate — negates a BabyJubJub point: -(x, y) = (p - x, y).
    access(all) view fun negate(_ point: {String: UInt256}): {String: UInt256} {
        let x = point["x"] ?? panic("point missing key 'x'")
        let y = point["y"] ?? panic("point missing key 'y'")
        return PedersenBabyJub._negateCoords(x: x, y: y)
    }

    /// isIdentity — returns true if the point is (0, 1).
    access(all) view fun isIdentity(_ point: {String: UInt256}): Bool {
        let x = point["x"] ?? panic("point missing key 'x'")
        let y = point["y"] ?? panic("point missing key 'y'")
        return x == self.IDENTITY_X && y == self.IDENTITY_Y
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    access(self) view fun _negateCoords(x: UInt256, y: UInt256): {String: UInt256} {
        let negX: UInt256 = x == 0 ? 0 : self.BN254_P - x
        return {"x": negX, "y": y}
    }

    /// _babyAddViaEVM — internal cross-VM dispatch for BabyJubJub point addition.
    ///
    /// Selector: babyAdd(uint256,uint256,uint256,uint256) = 0xa54a0868
    /// Panics on EVM failure — callers rely on this being atomic.
    ///
    access(self) fun _babyAddViaEVM(
        c1x: UInt256, c1y: UInt256,
        c2x: UInt256, c2y: UInt256,
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): {String: UInt256} {
        let helperAddr = EVM.addressFromString(self.BABYJUB_HELPER_ADDR)

        // [selector(4)] + ABI-encode(c1x, c1y, c2x, c2y)
        let args = EVM.encodeABI([c1x, c1y, c2x, c2y])
        let calldata = self.SEL_BABY_ADD.concat(args)

        let result = coa.call(
            to: helperAddr,
            data: calldata,
            gasLimit: 80_000,
            value: EVM.Balance(attoflow: 0)
        )

        // MUST check status — Cadence does NOT auto-revert on EVM failure
        if result.status != EVM.Status.successful {
            panic(
                "PedersenBabyJub: babyAdd EVM call failed"
                    .concat(" [code=").concat(result.errorCode.toString())
                    .concat("] ").concat(result.errorMessage)
            )
        }

        let decoded = EVM.decodeABI(
            types: [Type<UInt256>(), Type<UInt256>()],
            data: result.data
        )
        let resX = decoded[0] as! UInt256
        let resY = decoded[1] as! UInt256

        return {"x": resX, "y": resY}
    }

    // -----------------------------------------------------------------------
    // Admin resource — post-deploy address migration
    // -----------------------------------------------------------------------

    access(all) resource Admin {
        access(all) fun setHelperAddr(_ newAddr: String) {
            let old = PedersenBabyJub.BABYJUB_HELPER_ADDR
            PedersenBabyJub.BABYJUB_HELPER_ADDR = newAddr
            emit PedersenBabyJub.HelperAddressUpdated(oldAddr: old, newAddr: newAddr)
        }
    }

    // -----------------------------------------------------------------------
    // Initializer
    // -----------------------------------------------------------------------

    init(babyJubHelperAddress: String) {
        self.BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

        self.BABYJUB_A = 168700
        self.BABYJUB_D = 168696

        // BASE8: 8 * standard BabyJubJub generator (circomlib Pedersen base point)
        self.BASE8_X = 5299619240641551281634865583518297030282874472190772894086521144482721001553
        self.BASE8_Y = 16950150798460657717958625567821834550301663161624707787222815936182638968203

        self.IDENTITY_X = 0
        self.IDENTITY_Y = 1

        self.BABYJUB_HELPER_ADDR = babyJubHelperAddress

        // keccak256("babyAdd(uint256,uint256,uint256,uint256)")[:4] = 0xa54a0868
        self.SEL_BABY_ADD = [0xa5, 0x4a, 0x08, 0x68]

        let admin <- create Admin()
        self.account.storage.save(<-admin, to: /storage/PedersenBabyJubAdmin)
    }
}
