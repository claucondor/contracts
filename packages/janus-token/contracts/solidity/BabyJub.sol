// SPDX-License-Identifier: MIT
// BabyJub.sol — BabyJubJub twisted Edwards curve operations on Flow EVM
//
// BabyJubJub twisted Edwards curve over BN254 scalar field:
//   a*x^2 + y^2 = 1 + d*x^2*y^2   over F_p
//   a = 168700
//   d = 168696
//   p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//
// Generator G (circomlib standard generator):
//   x = 995203441582195749578291179787384436505546430278305826713579947235728471134
//   y = 5472060717959818805561601436314318772137091100104008585924551046643952123905
//
// BASE8 (circomlib Pedersen base point = 8 * G):
//   x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
//   y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
//
// Neutral element (identity):
//   (0, 1)
//
// Deployed to Flow EVM testnet at: 0x27139AFda7425f51F68D32e0A38b7D43BcB0f870
// Callable from Cadence via coa.call() or EVM.dryCall() for view functions.
//
// Gas profile (measured on Flow EVM testnet):
//   babyAdd    ~ 34,511 gas  (2 modexp precompile calls + field arithmetic)
//   isOnCurve  ~ 23,660 gas
//   identity   ~ 21,600 gas
//   negate     ~ 23,660 gas

pragma solidity ^0.8.20;

contract BabyJub {
    // -----------------------------------------------------------------------
    // Curve constants — circomlib-compatible BabyJubJub parameters
    // -----------------------------------------------------------------------

    /// @dev BN254 scalar field prime (= BabyJubJub base field prime)
    uint256 internal constant P =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @dev Curve coefficient a
    uint256 internal constant A = 168700;

    /// @dev Curve coefficient d
    uint256 internal constant D = 168696;

    /// @dev Generator G x-coordinate (circomlib standard generator)
    uint256 internal constant GX =
        995203441582195749578291179787384436505546430278305826713579947235728471134;

    /// @dev Generator G y-coordinate
    uint256 internal constant GY =
        5472060717959818805561601436314318772137091100104008585924551046643952123905;

    /// @dev BASE8 x-coordinate (8 * G, used by circomlib Pedersen)
    uint256 internal constant BASE8_X =
        5299619240641551281634865583518297030282874472190772894086521144482721001553;

    /// @dev BASE8 y-coordinate
    uint256 internal constant BASE8_Y =
        16950150798460657717958625567821834550301663161624707787222815936182638968203;

    // -----------------------------------------------------------------------
    // babyAdd — twisted Edwards point addition
    // -----------------------------------------------------------------------
    //
    // Addition law for a*x^2 + y^2 = 1 + d*x^2*y^2:
    //
    //   x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)
    //   y3 = (y1*y2 - a*x1*x2) / (1 - d*x1*x2*y1*y2)
    //
    // All arithmetic is mod P. Division is implemented as multiplication
    // by the modular inverse, computed via Fermat's little theorem:
    //   inv(a) = a^(P-2) mod P  (using the modexp precompile at address 0x05)
    //
    // The twisted Edwards addition law is unified — it handles all cases
    // including (P1 = identity), (P2 = identity), and (P1 = P2) without
    // special-casing. For prime-order subgroup points, denominators are
    // guaranteed to be non-zero.
    //
    function babyAdd(
        uint256 x1,
        uint256 y1,
        uint256 x2,
        uint256 y2
    ) public view returns (uint256 x3, uint256 y3) {
        // tau = x1*x2*y1*y2 mod P   (shared factor in both denominators)
        uint256 tau = mulmod(mulmod(x1, x2, P), mulmod(y1, y2, P), P);

        // dtau = d * tau mod P
        uint256 dtau = mulmod(D, tau, P);

        // Numerator for x3: x1*y2 + y1*x2
        uint256 numX = addmod(mulmod(x1, y2, P), mulmod(y1, x2, P), P);

        // Denominator for x3: 1 + d*tau
        uint256 denX = addmod(1, dtau, P);

        // Numerator for y3: y1*y2 - a*x1*x2
        //   = y1*y2 + (P - a*x1*x2)   to avoid underflow
        uint256 numY = addmod(
            mulmod(y1, y2, P),
            P - mulmod(A, mulmod(x1, x2, P), P),
            P
        );

        // Denominator for y3: 1 - d*tau
        //   = 1 + (P - d*tau) mod P   to avoid underflow
        uint256 denY = addmod(1, P - dtau, P);

        x3 = mulmod(numX, _modInverse(denX), P);
        y3 = mulmod(numY, _modInverse(denY), P);
    }

    // -----------------------------------------------------------------------
    // isOnCurve — curve membership check
    // -----------------------------------------------------------------------
    //
    // Verifies a*x^2 + y^2 == 1 + d*x^2*y^2 (mod P).
    // The identity point (0, 1) satisfies this equation.
    //
    function isOnCurve(uint256 x, uint256 y) public pure returns (bool) {
        uint256 x2 = mulmod(x, x, P);
        uint256 y2 = mulmod(y, y, P);

        // LHS: a*x^2 + y^2 mod P
        uint256 lhs = addmod(mulmod(A, x2, P), y2, P);

        // RHS: 1 + d*x^2*y^2 mod P
        uint256 rhs = addmod(1, mulmod(D, mulmod(x2, y2, P), P), P);

        return lhs == rhs;
    }

    // -----------------------------------------------------------------------
    // identity — neutral element of the group
    // -----------------------------------------------------------------------
    //
    // The identity (neutral element) for twisted Edwards curves is (0, 1).
    // Adding any point P to identity returns P unchanged.
    //
    function identity() public pure returns (uint256 x, uint256 y) {
        return (0, 1);
    }

    // -----------------------------------------------------------------------
    // negate — point negation
    // -----------------------------------------------------------------------
    //
    // In twisted Edwards coordinates, the negation of (x, y) is (-x, y).
    // On a prime field: -x mod P = P - x  (for x != 0).
    //
    // To subtract point B from A: babyAdd(Ax, Ay, negate(Bx, By))
    //
    function negate(
        uint256 x,
        uint256 y
    ) public pure returns (uint256 nx, uint256 ny) {
        nx = x == 0 ? 0 : P - x;
        ny = y;
    }

    // -----------------------------------------------------------------------
    // Internal: modular inverse via the modexp precompile
    // -----------------------------------------------------------------------
    //
    // Computes a^(P-2) mod P by invoking the EVM modexp precompile at 0x05.
    // Cost: ~450 gas (precompile) vs ~150k gas (pure Solidity loop).
    //
    // The precompile input layout (per EIP-198):
    //   [Bsize (32B)] [Esize (32B)] [Msize (32B)] [B (32B)] [E (32B)] [M (32B)]
    //   where B=a, E=P-2, M=P.
    //
    function _modInverse(uint256 a) internal view returns (uint256 result) {
        require(a != 0, "BabyJub: modular inverse of zero");
        bool success;
        (success, result) = _modExp(a, P - 2, P);
        require(success, "BabyJub: modexp precompile failed");
    }

    function _modExp(
        uint256 base,
        uint256 exp,
        uint256 mod
    ) internal view returns (bool success, uint256 result) {
        bytes memory input = abi.encodePacked(
            uint256(32), // length of base
            uint256(32), // length of exponent
            uint256(32), // length of modulus
            base,
            exp,
            mod
        );
        bytes memory out = new bytes(32);
        assembly {
            success := staticcall(
                gas(),
                0x05, // modexp precompile
                add(input, 0x20),
                mload(input),
                add(out, 0x20),
                32
            )
        }
        if (success) {
            result = abi.decode(out, (uint256));
        }
    }
}
