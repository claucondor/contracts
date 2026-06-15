// Pedersen2GenBabyJub.cdc — Cross-VM 2-generator Pedersen commitment for BabyJubJub
//
// Implements homomorphic commitment operations on Flow Cadence, with point
// arithmetic delegated to BabyJub.sol on Flow EVM via the cross-VM call pattern.
//
// Commitment scheme:
//   Commit(v, r) := [v]·G + [r]·H
//
// where G = Base8 (prime-order subgroup generator) and H is the NUMS second generator.
//
// ARCHITECTURE
// ─────────────────────────────────────────────────────────────────────────────
// Commitment computation is done off-chain by the TypeScript SDK (src/commitment.ts).
// This Cadence contract provides:
//   1. addCommits(c1, c2) — homomorphic addition of two commitments
//   2. subCommits(c1, c2) — homomorphic subtraction
//   3. Constants: G (Base8), H (NUMS), SUBORDER
//   4. Pure helpers: negate, isIdentity, identity
//
// GENERATOR VALUES
// ─────────────────────────────────────────────────────────────────────────────
// G = Base8 (prime-order subgroup generator of BabyJubJub):
//   G_x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
//   G_y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
//
// H = NUMS second generator (see TypeScript generators.ts for full derivation trace):
//   H_SEED_HASH = dab770fa437522466cc77e342af81afeeea9cf70e63ad98b83463b5819288b13
//   scalar      = 431220823411395456446588864425906976884578672973864058140779376804016099631
//   H_x         = 20176122646359037043957983780698997220241005801156909477756461731029015465513
//   H_y         = 12675495183377259114213499882541802147068931119123218019653136042509354750865
//
// CU BUDGET
// ─────────────────────────────────────────────────────────────────────────────
// addCommits: ~16 CU Cadence dispatch + EVM execution (~34k gas)
// subCommits: ~21 CU (negate is pure Cadence ~5 CU + addCommits)
// negate:     ~5 CU (pure Cadence — no EVM call)
// Cadence tx limit: 9,999 CU. All operations are well within the limit.

import "EVM"

access(all) contract Pedersen2GenBabyJub {

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// BN254 base field prime (= BabyJubJub field prime)
    access(all) let BN254_P: UInt256

    /// BabyJubJub prime-order subgroup order l
    access(all) let SUBORDER: UInt256

    /// Generator G = Base8 (prime-order subgroup generator)
    access(all) let G_X: UInt256
    access(all) let G_Y: UInt256

    /// Generator H (NUMS second generator in prime-order subgroup)
    access(all) let H_X: UInt256
    access(all) let H_Y: UInt256

    /// Identity element (0, 1)
    access(all) let IDENTITY_X: UInt256
    access(all) let IDENTITY_Y: UInt256

    /// SHA-256 hash of the H derivation seed (for independent verification)
    access(all) let H_SEED_HASH: String

    /// EVM address of BabyJub.sol helper contract
    access(all) var BABYJUB_HELPER_ADDR: String

    /// Function selector: babyAdd(uint256,uint256,uint256,uint256) = 0xa54a0868
    access(self) let SEL_BABY_ADD: [UInt8]

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    access(all) event HelperAddressUpdated(oldAddr: String, newAddr: String)

    // ─────────────────────────────────────────────────────────────────────────
    // Core point operations
    // ─────────────────────────────────────────────────────────────────────────

    /// addCommits — homomorphic addition of two Pedersen commitments
    ///
    /// Homomorphism: addCommits(Commit(v1,r1), Commit(v2,r2)) = Commit(v1+v2, r1+r2)
    ///
    /// This is the fundamental accumulation operation for additive privacy balances.
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

    /// subCommits — homomorphic subtraction: c1 - c2
    ///
    /// Negation uses the twisted Edwards formula: -(x, y) = (P - x, y)
    /// The subtraction is performed as addCommits(c1, negate(c2)).
    access(all) fun subCommits(
        c1: {String: UInt256},
        c2: {String: UInt256},
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): {String: UInt256} {
        let c2x = c2["x"] ?? panic("c2 missing key 'x'")
        let c2y = c2["y"] ?? panic("c2 missing key 'y'")
        let neg = self._negateCoords(x: c2x, y: c2y)
        let c1x = c1["x"] ?? panic("c1 missing key 'x'")
        let c1y = c1["y"] ?? panic("c1 missing key 'y'")
        return self._babyAddViaEVM(c1x: c1x, c1y: c1y, c2x: neg["x"]!, c2y: neg["y"]!, coa: coa)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pure Cadence helpers (no EVM call)
    // ─────────────────────────────────────────────────────────────────────────

    /// identity — returns the neutral element (0, 1)
    access(all) view fun identity(): {String: UInt256} {
        return {"x": self.IDENTITY_X, "y": self.IDENTITY_Y}
    }

    /// isIdentity — returns true if the point is the identity element
    access(all) view fun isIdentity(_ point: {String: UInt256}): Bool {
        let x = point["x"] ?? panic("point missing 'x'")
        let y = point["y"] ?? panic("point missing 'y'")
        return x == self.IDENTITY_X && y == self.IDENTITY_Y
    }

    /// negate — negate a BabyJubJub commitment point (pure Cadence, no EVM call)
    /// Twisted Edwards negation: -(x, y) = (P - x, y)
    access(all) view fun negate(_ point: {String: UInt256}): {String: UInt256} {
        let x = point["x"] ?? panic("point missing 'x'")
        let y = point["y"] ?? panic("point missing 'y'")
        return self._negateCoords(x: x, y: y)
    }

    /// generatorG — returns the prime-order subgroup generator G = Base8
    access(all) view fun generatorG(): {String: UInt256} {
        return {"x": self.G_X, "y": self.G_Y}
    }

    /// generatorH — returns the NUMS second generator H
    access(all) view fun generatorH(): {String: UInt256} {
        return {"x": self.H_X, "y": self.H_Y}
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    access(self) view fun _negateCoords(x: UInt256, y: UInt256): {String: UInt256} {
        let negX: UInt256 = x == 0 ? 0 : self.BN254_P - x
        return {"x": negX, "y": y}
    }

    access(self) fun _babyAddViaEVM(
        c1x: UInt256, c1y: UInt256,
        c2x: UInt256, c2y: UInt256,
        coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
    ): {String: UInt256} {
        let helperAddr = EVM.addressFromString(self.BABYJUB_HELPER_ADDR)
        let args = EVM.encodeABI([c1x, c1y, c2x, c2y])
        let calldata = self.SEL_BABY_ADD.concat(args)

        let result = coa.call(
            to: helperAddr,
            data: calldata,
            gasLimit: 80_000,
            value: EVM.Balance(attoflow: 0)
        )

        if result.status != EVM.Status.successful {
            panic(
                "Pedersen2GenBabyJub: babyAdd EVM call failed"
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

    // ─────────────────────────────────────────────────────────────────────────
    // Admin resource — update BabyJub helper address
    // ─────────────────────────────────────────────────────────────────────────

    access(all) resource Admin {
        access(all) fun setHelperAddr(_ newAddr: String) {
            let old = Pedersen2GenBabyJub.BABYJUB_HELPER_ADDR
            Pedersen2GenBabyJub.BABYJUB_HELPER_ADDR = newAddr
            emit Pedersen2GenBabyJub.HelperAddressUpdated(oldAddr: old, newAddr: newAddr)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initializer
    // ─────────────────────────────────────────────────────────────────────────

    init(babyJubHelperAddress: String) {
        // BN254 base field prime
        self.BN254_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

        // Prime-order subgroup order
        self.SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041

        // Generator G = Base8
        self.G_X = 5299619240641551281634865583518297030282874472190772894086521144482721001553
        self.G_Y = 16950150798460657717958625567821834550301663161624707787222815936182638968203

        // Generator H (NUMS derivation: scalar * Base8)
        self.H_X = 20176122646359037043957983780698997220241005801156909477756461731029015465513
        self.H_Y = 12675495183377259114213499882541802147068931119123218019653136042509354750865

        // Identity element
        self.IDENTITY_X = 0
        self.IDENTITY_Y = 1

        // NUMS seed hash documentation
        self.H_SEED_HASH = "dab770fa437522466cc77e342af81afeeea9cf70e63ad98b83463b5819288b13"

        // BabyJub.sol helper address
        self.BABYJUB_HELPER_ADDR = babyJubHelperAddress

        // Function selector for babyAdd(uint256,uint256,uint256,uint256) = 0xa54a0868
        self.SEL_BABY_ADD = [0xa5, 0x4a, 0x08, 0x68]

        // Store Admin resource
        let admin <- create Admin()
        self.account.storage.save(<-admin, to: /storage/Pedersen2GenBabyJubAdmin)
    }
}
