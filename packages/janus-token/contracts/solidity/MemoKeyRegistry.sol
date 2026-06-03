// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// MemoKeyRegistry.sol — Shared BabyJubJub pubkey registry for all Janus tokens.
//
// Replaces per-token memoKeyPubX/memoKeyPubY mappings with a single source of
// truth.  EVM users call publishMemoKey() here ONCE; every Janus EVM proxy reads
// from this contract (read-only) — they no longer write memo key state themselves.
//
// Cadence users publish via the cross-VM Cadence transaction
// transactions/publish_memokey_xvm.cdc, which calls publishMemoKey() here from
// the user's COA so msg.sender is the COA EVM address.
//
// DESIGN:
//   • Immutable (no proxy, no admin) — simplest possible for audit surface.
//   • One-time publish: use rotateMemoKey for subsequent updates.
//   • BabyJubJub curve validation: ax² + y² = 1 + dx²y² (mod p)
//       a = 168700
//       d = 168696
//       p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
//     This is the same curve used by all v0.6 proofs / verifiers.
//
// Solidity 0.8.20; no OpenZeppelin dependency (no upgradability, no ownership).

pragma solidity ^0.8.20;

contract MemoKeyRegistry {
    // -----------------------------------------------------------------------
    // BabyJubJub curve constants
    //
    // Curve equation: a*x² + y² = 1 + d*x²*y²  (twisted Edwards over F_p)
    // -----------------------------------------------------------------------

    /// Prime field modulus for BabyJubJub (= alt_bn128 scalar field).
    uint256 private constant P =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// Curve coefficient a = 168700 (decimal).
    uint256 private constant A = 168700;

    /// Curve coefficient d = 168696 (decimal).
    uint256 private constant D = 168696;

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    struct MemoKey {
        uint256 x;
        uint256 y;
        uint256 publishedAt; // block.timestamp of last write; 0 means unregistered
    }

    mapping(address => MemoKey) public memoKeys;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// Emitted on first-time registration.
    event MemoKeyPublished(address indexed user, uint256 x, uint256 y);

    /// Emitted on key rotation (second + subsequent writes).
    event MemoKeyRotated(address indexed user, uint256 newX, uint256 newY);

    // -----------------------------------------------------------------------
    // External write functions
    // -----------------------------------------------------------------------

    /// @notice Register the caller's BabyJub pubkey. Call once; rotate later.
    /// @param x  BabyJub pubkey X coordinate (must be in [1, P-1]).
    /// @param y  BabyJub pubkey Y coordinate (must be in [1, P-1]).
    function publishMemoKey(uint256 x, uint256 y) external {
        require(x != 0 && y != 0, "MemoKeyRegistry: invalid point (zero coord)");
        require(x < P && y < P,   "MemoKeyRegistry: coord out of field range");
        require(_isOnBabyJubCurve(x, y), "MemoKeyRegistry: point not on BabyJub curve");
        require(
            memoKeys[msg.sender].publishedAt == 0,
            "MemoKeyRegistry: already published, use rotateMemoKey"
        );
        memoKeys[msg.sender] = MemoKey({ x: x, y: y, publishedAt: block.timestamp });
        emit MemoKeyPublished(msg.sender, x, y);
    }

    /// @notice Rotate to a new BabyJub pubkey. Must have published first.
    /// @param newX  New BabyJub pubkey X coordinate.
    /// @param newY  New BabyJub pubkey Y coordinate.
    function rotateMemoKey(uint256 newX, uint256 newY) external {
        require(
            memoKeys[msg.sender].publishedAt != 0,
            "MemoKeyRegistry: not yet published, use publishMemoKey"
        );
        require(newX != 0 && newY != 0, "MemoKeyRegistry: invalid point (zero coord)");
        require(newX < P && newY < P,   "MemoKeyRegistry: coord out of field range");
        require(_isOnBabyJubCurve(newX, newY), "MemoKeyRegistry: point not on BabyJub curve");
        memoKeys[msg.sender] = MemoKey({ x: newX, y: newY, publishedAt: block.timestamp });
        emit MemoKeyRotated(msg.sender, newX, newY);
    }

    // -----------------------------------------------------------------------
    // External view function
    // -----------------------------------------------------------------------

    /// @notice Retrieve the registered key for `user`.
    /// @return x           BabyJub pubkey X (0 if not registered).
    /// @return y           BabyJub pubkey Y (0 if not registered).
    /// @return publishedAt Timestamp of last write (0 if not registered).
    function getMemoKey(address user)
        external
        view
        returns (uint256 x, uint256 y, uint256 publishedAt)
    {
        MemoKey memory k = memoKeys[user];
        return (k.x, k.y, k.publishedAt);
    }

    // -----------------------------------------------------------------------
    // Curve validation (internal)
    // -----------------------------------------------------------------------

    /// @dev Verifies ax² + y² ≡ 1 + dx²y²  (mod P).
    ///      All arithmetic is performed mod P using Solidity's mulmod / addmod.
    ///
    ///      Note: We do NOT check that the point is in the prime-order subgroup
    ///      (i.e., we do not multiply by the cofactor 8). For a pubkey registry
    ///      this is acceptable: small-subgroup points encode no encryption key
    ///      and the sender is simply wasting their own gas. Groth16 proofs in
    ///      the transfer circuit enforce proper subgroup membership at proof time.
    function _isOnBabyJubCurve(uint256 x, uint256 y) internal pure returns (bool) {
        // x2 = x² mod p
        uint256 x2 = mulmod(x, x, P);
        // y2 = y² mod p
        uint256 y2 = mulmod(y, y, P);

        // lhs = a*x2 + y2  mod p
        uint256 ax2 = mulmod(A, x2, P);
        uint256 lhs  = addmod(ax2, y2, P);

        // rhs = 1 + d*x2*y2  mod p
        uint256 dx2y2 = mulmod(mulmod(D, x2, P), y2, P);
        uint256 rhs   = addmod(1, dx2y2, P);

        return lhs == rhs;
    }
}
