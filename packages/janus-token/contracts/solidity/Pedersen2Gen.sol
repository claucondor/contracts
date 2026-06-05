// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
// Audit and multi-party ceremony required before mainnet deployment.
//
// Pedersen2Gen.sol — on-chain 2-generator Pedersen commitment for BabyJubJub
//
// Implements: Commit(v, r) := [v]·G + [r]·H
//
// where:
//   G = canonical BabyJub generator (Base8, prime-order subgroup)
//   H = NUMS second generator (SHA-256 derivation)
//
// This is the EVM reference for commitment construction.
// In production the commitment is computed off-chain (via @openjanus/commitment),
// and this contract is used for:
//   1. On-chain accumulation of commitments via addCommits (homomorphic point add)
//   2. Verifying that a submitted commitment is on the curve
//
// BabyJubJub twisted Edwards curve over BN254 scalar field:
//   a*x^2 + y^2 = 1 + d*x^2*y^2  (mod P)
//   a = 168700,  d = 168696
//   P = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//
// Generator G = Base8 (prime-order subgroup generator):
//   G_x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
//   G_y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
//
// Generator H (NUMS — SHA-256("openjanus:aggregate-pedersen:generator-H:v1") mod l * G):
//   H_x = 20176122646359037043957983780698997220241005801156909477756461731029015465513
//   H_y = 12675495183377259114213499882541802147068931119123218019653136042509354750865
//
// Homomorphism:
//   Commit(v1,r1) + Commit(v2,r2) = Commit(v1+v2, r1+r2)   (mod suborder)

pragma solidity ^0.8.20;

/// @title Pedersen2Gen — 2-generator Pedersen commitment on BabyJubJub
/// @dev Stateless — all functions are view/pure. Deploy once and reuse.
contract Pedersen2Gen {
    // ─────────────────────────────────────────────────────────────────────────
    // Curve constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev BN254 scalar field prime (= BabyJubJub base field prime)
    uint256 internal constant P =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @dev BabyJub coefficient a
    uint256 internal constant A = 168700;

    /// @dev BabyJub coefficient d
    uint256 internal constant D = 168696;

    /// @dev Prime-order subgroup order l
    uint256 internal constant SUBORDER =
        2736030358979909402780800718157159386076813972158567259200215660948447373041;

    // ─────────────────────────────────────────────────────────────────────────
    // Generator G — Base8 (prime-order subgroup generator of BabyJubJub)
    // G = 8 × (raw BabyJub generator). MUST be Base8, not raw generator,
    // because only Base8 is in the prime-order subgroup ([l]·G = identity).
    // ─────────────────────────────────────────────────────────────────────────

    uint256 internal constant GX =
        5299619240641551281634865583518297030282874472190772894086521144482721001553;
    uint256 internal constant GY =
        16950150798460657717958625567821834550301663161624707787222815936182638968203;

    // ─────────────────────────────────────────────────────────────────────────
    // Generator H — NUMS second generator (in prime-order subgroup)
    // Derivation: H = sha256_scalar(seed) * G where G = Base8
    // Seed:       "openjanus:aggregate-pedersen:generator-H:v1"
    // ─────────────────────────────────────────────────────────────────────────

    uint256 internal constant HX =
        20176122646359037043957983780698997220241005801156909477756461731029015465513;
    uint256 internal constant HY =
        12675495183377259114213499882541802147068931119123218019653136042509354750865;

    // ─────────────────────────────────────────────────────────────────────────
    // commit — compute [v]·G + [r]·H on-chain
    // ─────────────────────────────────────────────────────────────────────────
    //
    // @param v  Value (token amount, 128-bit range in production)
    // @param r  Blinding factor (252-bit subgroup scalar)
    // @return cx x-coordinate of commitment point
    // @return cy y-coordinate of commitment point
    //
    // Gas note: this function performs 2 full scalar multiplications on
    // BabyJubJub using double-and-add. Expensive on-chain (~2M+ gas).
    // In production: compute commitments off-chain (@openjanus/commitment) and
    // only use addCommits() on-chain for the accumulator update (~50k gas).
    // This function is provided for testing and cross-verification only.
    //
    function commit(uint256 v, uint256 r)
        public
        view
        returns (uint256 cx, uint256 cy)
    {
        // [v]·G
        (uint256 vGx, uint256 vGy) = _scalarMul(GX, GY, v % SUBORDER);

        // [r]·H
        (uint256 rHx, uint256 rHy) = _scalarMul(HX, HY, r % SUBORDER);

        // Commit = [v]·G + [r]·H
        (cx, cy) = _babyAdd(vGx, vGy, rHx, rHy);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addCommits — homomorphic addition of two commitments
    // ─────────────────────────────────────────────────────────────────────────
    //
    // Returns p1 + p2 on the BabyJubJub curve.
    // This is the low-gas path for on-chain balance accumulation.
    //
    function addCommits(
        uint256 x1, uint256 y1,
        uint256 x2, uint256 y2
    )
        public
        view
        returns (uint256 rx, uint256 ry)
    {
        (rx, ry) = _babyAdd(x1, y1, x2, y2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // generatorG / generatorH — expose generators for off-chain computation
    // ─────────────────────────────────────────────────────────────────────────

    function generatorG() external pure returns (uint256 gx, uint256 gy) {
        return (GX, GY);
    }

    function generatorH() external pure returns (uint256 hx, uint256 hy) {
        return (HX, HY);
    }

    function suborder() external pure returns (uint256) {
        return SUBORDER;
    }

    function isOnCurve(uint256 x, uint256 y) external pure returns (bool) {
        return _isOnCurve(x, y);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal: BabyJubJub twisted Edwards point addition
    // ─────────────────────────────────────────────────────────────────────────

    function _babyAdd(
        uint256 x1, uint256 y1,
        uint256 x2, uint256 y2
    ) internal view returns (uint256 x3, uint256 y3) {
        uint256 tau = mulmod(mulmod(x1, x2, P), mulmod(y1, y2, P), P);
        uint256 dtau = mulmod(D, tau, P);

        uint256 numX = addmod(mulmod(x1, y2, P), mulmod(y1, x2, P), P);
        uint256 denX = addmod(1, dtau, P);

        uint256 numY = addmod(
            mulmod(y1, y2, P),
            P - mulmod(A, mulmod(x1, x2, P), P),
            P
        );
        uint256 denY = addmod(1, P - dtau, P);

        x3 = mulmod(numX, _modInverse(denX), P);
        y3 = mulmod(numY, _modInverse(denY), P);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal: double-and-add scalar multiplication on BabyJubJub
    // ─────────────────────────────────────────────────────────────────────────

    function _scalarMul(
        uint256 px,
        uint256 py,
        uint256 scalar
    ) internal view returns (uint256 rx, uint256 ry) {
        // identity element
        rx = 0;
        ry = 1;
        uint256 ex = px;
        uint256 ey = py;

        while (scalar > 0) {
            if (scalar & 1 == 1) {
                (rx, ry) = _babyAdd(rx, ry, ex, ey);
            }
            (ex, ey) = _babyAdd(ex, ey, ex, ey);
            scalar >>= 1;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal: curve membership check
    // ─────────────────────────────────────────────────────────────────────────

    function _isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        uint256 x2 = mulmod(x, x, P);
        uint256 y2 = mulmod(y, y, P);
        uint256 lhs = addmod(mulmod(A, x2, P), y2, P);
        uint256 rhs = addmod(1, mulmod(D, mulmod(x2, y2, P), P), P);
        return lhs == rhs;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal: modular inverse via Fermat's little theorem (modexp precompile)
    // ─────────────────────────────────────────────────────────────────────────

    function _modInverse(uint256 a) internal view returns (uint256 result) {
        require(a != 0, "Pedersen2Gen: modular inverse of zero");
        bool success;
        bytes memory input = abi.encodePacked(
            uint256(32), uint256(32), uint256(32), a, P - 2, P
        );
        bytes memory out = new bytes(32);
        assembly {
            success := staticcall(
                gas(),
                0x05,
                add(input, 0x20),
                mload(input),
                add(out, 0x20),
                32
            )
        }
        require(success, "Pedersen2Gen: modexp precompile failed");
        result = abi.decode(out, (uint256));
    }
}
