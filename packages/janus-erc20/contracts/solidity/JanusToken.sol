// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusToken.sol — Abstract base for openjanus confidential tokens (v0.7.1).
//
// v0.7.1 — amount-disclose aggregate verifier integration
//
// Adds wrapWithProof() path: AmountDiscloseAggregateVerifier verifies that the
// submitted Pedersen commitment encodes the wrap amount with a valid blinding
// factor. Anti-replay via usedNonces[caller][nonce].
// Public input layout: [amount, commitX, commitY, nonce]
//
// v0.7.0 — 2-generator Pedersen aggregate commitment upgrade
//
// Replaces windowed-Pedersen accumulation with the 2-generator Pedersen scheme:
//
//   Commit(v, r) := [v]·G + [r]·H
//
// This is homomorphic: Commit(v1,r1) + Commit(v2,r2) = Commit(v1+v2, r1+r2)
// so the on-chain accumulator correctly tracks accumulated deposits after N wraps.
//
// Storage layout (fresh-deploy, UUPS compatible within this deploy):
//
//   slot 0 .. 49 (UUPS + Ownable)
//   slot 50   babyJub               (retained for negate() in debit path)
//   slot 51   transferVerifier
//   slot 52   amountDiscloseVerifier
//   slot 53   commitments           mapping(address => Point)
//   slot 54   totalSupplyCommitment.x
//   slot 55   totalSupplyCommitment.y
//   slot 56   totalLocked
//   slot 57   pedersen2Gen          address  <-- NEW in v0.7.0
//   slot 58..97  __gap[40]          reserved
//   slot 98   usedNonces            mapping(address => mapping(uint256 => bool))  <-- NEW in v0.7.1

pragma solidity ^0.8.20;

import {UUPSUpgradeable}      from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable}   from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable}        from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// ---------------------------------------------------------------------------
// External verifier / curve interfaces
// ---------------------------------------------------------------------------

interface IBabyJub {
    function babyAdd(
        uint256 x1, uint256 y1,
        uint256 x2, uint256 y2
    ) external view returns (uint256 x3, uint256 y3);

    function negate(uint256 x, uint256 y) external pure returns (uint256 nx, uint256 ny);
}

interface IConfidentialTransferVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[6] calldata _pubSignals
    ) external view returns (bool);
}

/// @dev AmountDiscloseAggregateVerifier — 4 public inputs: [amount, commitX, commitY, nonce]
interface IAmountDiscloseVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[4] calldata _pubSignals
    ) external view returns (bool);
}

interface IPedersen2Gen {
    function addCommits(
        uint256 x1, uint256 y1,
        uint256 x2, uint256 y2
    ) external view returns (uint256 rx, uint256 ry);

    function isOnCurve(uint256 x, uint256 y) external pure returns (bool);
}

// ---------------------------------------------------------------------------
// JanusToken — abstract base (v0.7.0, aggregate commitment upgrade)
// ---------------------------------------------------------------------------

abstract contract JanusToken is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable
{
    // -----------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------

    struct Point {
        uint256 x;
        uint256 y;
    }

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    IBabyJub                       public babyJub;
    IConfidentialTransferVerifier  public transferVerifier;
    IAmountDiscloseVerifier        public amountDiscloseVerifier;

    mapping(address => Point) public commitments;

    Point public totalSupplyCommitment;

    uint256 public totalLocked;

    /// 2-generator Pedersen commitment library — homomorphic accumulator.
    IPedersen2Gen    public pedersen2Gen;

    /// Reserved storage for future state vars.
    uint256[40] private __gap;

    /// Anti-replay nonces for wrapWithProof.
    /// usedNonces[caller][nonce] = true after the nonce has been consumed.
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event Wrapped(address indexed user, uint256 amount);
    event Unwrapped(address indexed user, address indexed recipient, uint256 amount);
    event ConfidentialTransfer(address indexed from, address indexed to);

    // -----------------------------------------------------------------------
    // Initializer
    // -----------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function __JanusToken_init(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _owner,
        address _pedersen2Gen
    ) internal onlyInitializing {
        require(_babyJub                != address(0), "JanusToken: zero babyJub");
        require(_transferVerifier       != address(0), "JanusToken: zero transferVerifier");
        require(_amountDiscloseVerifier != address(0), "JanusToken: zero amountDiscloseVerifier");
        require(_owner                  != address(0), "JanusToken: zero owner");
        require(_pedersen2Gen           != address(0), "JanusToken: zero pedersen2Gen");

        __Ownable_init(_owner);
        __UUPSUpgradeable_init();

        babyJub                = IBabyJub(_babyJub);
        transferVerifier       = IConfidentialTransferVerifier(_transferVerifier);
        amountDiscloseVerifier = IAmountDiscloseVerifier(_amountDiscloseVerifier);
        pedersen2Gen           = IPedersen2Gen(_pedersen2Gen);

        totalSupplyCommitment = Point({ x: 0, y: 1 });
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -----------------------------------------------------------------------
    // Verifier admin
    // -----------------------------------------------------------------------

    /// @notice Update the AmountDiscloseVerifier address. Owner-only.
    /// Used after UUPS upgrades to point to the latest verifier contract.
    function setAmountDiscloseVerifier(address _verifier) external onlyOwner {
        require(_verifier != address(0), "JanusToken: zero amountDiscloseVerifier");
        amountDiscloseVerifier = IAmountDiscloseVerifier(_verifier);
    }

    // -----------------------------------------------------------------------
    // View helpers
    // -----------------------------------------------------------------------

    function balanceOfCommitment(address account) external view returns (Point memory) {
        return _effectiveCommitment(account);
    }

    function balanceOfCommitmentXY(address account) external view returns (uint256 x, uint256 y) {
        Point memory p = _effectiveCommitment(account);
        return (p.x, p.y);
    }

    /// @dev Converts uninitialised storage (0, 0) to BabyJubJub identity (0, 1).
    function _effectiveCommitment(address account) internal view returns (Point memory) {
        Point memory c = commitments[account];
        if (c.x == 0 && c.y == 0) {
            return Point({ x: 0, y: 1 });
        }
        return c;
    }

    // -----------------------------------------------------------------------
    // shieldedTransfer — 3-arg base version (overridden by JanusERC20 9-arg)
    // -----------------------------------------------------------------------

    function shieldedTransfer(
        address to,
        uint256[6] calldata publicInputs,
        uint256[8] calldata proof
    ) external {
        require(to != address(0),  "JanusToken: transfer to zero address");
        require(to != msg.sender,  "JanusToken: cannot transfer to self");

        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            publicInputs[0] == senderCommit.x && publicInputs[1] == senderCommit.y,
            "JanusToken: C_old mismatch"
        );

        require(
            _verifyTransferProof(publicInputs, proof),
            "JanusToken: invalid transfer proof"
        );

        // Sender: set new_commit
        commitments[msg.sender] = Point({ x: publicInputs[4], y: publicInputs[5] });

        // Recipient: accumulate transfer_commit homomorphically
        Point memory recvCommit = _effectiveCommitment(to);
        (uint256 rx, uint256 ry) = pedersen2Gen.addCommits(
            recvCommit.x, recvCommit.y,
            publicInputs[2], publicInputs[3]
        );
        commitments[to] = Point({ x: rx, y: ry });

        emit ConfidentialTransfer(msg.sender, to);
    }

    // -----------------------------------------------------------------------
    // Abstract template-method hooks
    // -----------------------------------------------------------------------

    function _wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        uint256 nonce
    ) internal virtual;

    function _unwrap(
        uint256 claimedAmount,
        address payable recipient,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        uint256[6] calldata transferPublicInputs,
        uint256[8] calldata transferProof
    ) internal virtual;

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// @dev Verify an amount-disclose proof with nonce binding.
    /// Public input layout: [amount, commitX, commitY, nonce]
    function _verifyAmountDisclose(
        uint256 claimedAmount,
        uint256[2] calldata commit,
        uint256[8] calldata proof,
        uint256 nonce
    ) internal view returns (bool) {
        return amountDiscloseVerifier.verifyProof(
            [proof[0], proof[1]],
            [[proof[2], proof[3]], [proof[4], proof[5]]],
            [proof[6], proof[7]],
            [claimedAmount, commit[0], commit[1], nonce]
        );
    }

    function _verifyTransferProof(
        uint256[6] calldata publicInputs,
        uint256[8] calldata proof
    ) internal view returns (bool) {
        return transferVerifier.verifyProof(
            [proof[0], proof[1]],
            [[proof[2], proof[3]], [proof[4], proof[5]]],
            [proof[6], proof[7]],
            publicInputs
        );
    }

    /// @dev Accumulate txCommit into account's shielded balance (homomorphic).
    function _acceptShieldedCredit(
        address account,
        uint256[2] calldata txCommit
    ) internal {
        Point memory current = _effectiveCommitment(account);
        (uint256 nx, uint256 ny) = pedersen2Gen.addCommits(
            current.x, current.y,
            txCommit[0], txCommit[1]
        );
        commitments[account] = Point({ x: nx, y: ny });

        (uint256 sx, uint256 sy) = pedersen2Gen.addCommits(
            totalSupplyCommitment.x, totalSupplyCommitment.y,
            txCommit[0], txCommit[1]
        );
        totalSupplyCommitment = Point({ x: sx, y: sy });
    }

    function _processShieldedDebit(
        address account,
        uint256[2] calldata txCommit,
        uint256[6] calldata transferPublicInputs
    ) internal {
        commitments[account] = Point({
            x: transferPublicInputs[4],
            y: transferPublicInputs[5]
        });

        (uint256 negX, uint256 negY) = babyJub.negate(txCommit[0], txCommit[1]);
        (uint256 sx, uint256 sy) = pedersen2Gen.addCommits(
            totalSupplyCommitment.x, totalSupplyCommitment.y,
            negX, negY
        );
        totalSupplyCommitment = Point({ x: sx, y: sy });
    }
}
