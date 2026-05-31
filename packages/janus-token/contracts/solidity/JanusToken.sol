// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusToken.sol — Abstract base for openjanus confidential tokens (v0.3).
//
// This is the *template* that defines the on-chain shape of every confidential
// token in the openjanus stack:
//
//   - Hidden per-account balance commitments (BabyJubJub Pedersen).
//   - Hidden total-supply commitment (homomorphic sum of per-account commits).
//   - Cleartext aggregate custody accounting (`totalLocked`) — VISIBLE BY DESIGN
//     so observers can audit the size of the shielded pool.
//   - A shielded transfer that hides amount on all channels (calldata, events,
//     storage) gated by a Groth16 ConfidentialTransfer proof.
//   - Abstract `_wrap` / `_unwrap` template-method hooks that concrete tokens
//     (e.g. JanusFlow for native FLOW) implement to plug in the underlying
//     asset's custody logic.
//
// Concrete tokens MUST:
//
//   - Implement `_wrap(amount, txCommit, amountProof)` to take custody of
//     `amount` of the underlying asset and bind it to `txCommit` via the
//     AmountDiscloseVerifier.
//   - Implement `_unwrap(claimedAmount, recipient, txCommit, amountProof,
//     transferPublicInputs, transferProof)` to release `claimedAmount` of the
//     underlying asset to `recipient` after verifying both proofs.
//   - Call `_acceptShieldedCredit(account, txCommit)` from inside `_wrap` after
//     verifying the amount-disclose proof and (optionally) updating custody.
//   - Call `_processShieldedDebit(account, txCommit, transferPublicInputs)`
//     from inside `_unwrap` after verifying both proofs.
//
// Cryptographic dependencies (deployed primitive addresses, set in `__JanusToken_init`):
//
//   - BabyJub.sol                  — twisted Edwards point arithmetic.
//   - ConfidentialTransferVerifier — Groth16 verifier for the v2 transfer circuit.
//   - AmountDiscloseVerifier       — Groth16 verifier binding a Pedersen commit
//                                    to a PUBLIC scalar amount.
//
// Storage layout:
//
//   slot 0 .. 49 (UUPS + Ownable) — managed by OpenZeppelin upgradeable mixins.
//   slot 50      — IBabyJub babyJub
//   slot 51      — IConfidentialTransferVerifier transferVerifier
//   slot 52      — IAmountDiscloseVerifier        amountDiscloseVerifier
//   slot 53..    — mapping(address => Point) commitments
//                 Point totalSupplyCommitment
//                 uint256 totalLocked
//   slot N + __gap[40]  — reserved for future state.
//
// Concrete subclasses MUST NOT reorder existing storage or remove __gap entries
// without coordinating a synchronized storage migration.

pragma solidity ^0.8.20;

import {UUPSUpgradeable}      from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable}   from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable}        from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

// ---------------------------------------------------------------------------
// External verifier / curve interfaces (shape pinned by the lab deployments)
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

interface IAmountDiscloseVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[3] calldata _pubSignals
    ) external view returns (bool);
}

// ---------------------------------------------------------------------------
// JanusToken — abstract base
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
    // Storage — see file-header note about slot stability
    // -----------------------------------------------------------------------

    IBabyJub                       public babyJub;
    IConfidentialTransferVerifier  public transferVerifier;
    IAmountDiscloseVerifier        public amountDiscloseVerifier;

    /// Hidden per-account balance commitment (BabyJubJub point). Identity
    /// element (0, 1) means zero balance; uninitialised storage (0, 0) is
    /// treated as identity by `_effectiveCommitment`.
    mapping(address => Point) public commitments;

    /// Homomorphic sum of all `commitments[account]` — invariant:
    /// `totalSupplyCommitment == sum(commitments[a] for all a)`.
    Point public totalSupplyCommitment;

    /// Aggregate cleartext custody pool. Tracks the underlying asset locked
    /// in the contract across all users. VISIBLE BY DESIGN — boundary
    /// accounting that an external observer can audit at any time.
    uint256 public totalLocked;

    /// Reserved storage for future state vars. Decrement when adding fields
    /// to keep layout stable across upgrades.
    uint256[40] private __gap;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// VISIBLE BY DESIGN — boundary leak: discloses the wrap amount.
    event Wrapped(address indexed user, uint256 amount);

    /// VISIBLE BY DESIGN — boundary leak: discloses the unwrap amount and
    /// recipient.
    event Unwrapped(address indexed user, address indexed recipient, uint256 amount);

    /// HIDDEN — emits no amount data, matching the ERC-7984 confidential
    /// transfer event.
    event ConfidentialTransfer(address indexed from, address indexed to);

    /// TESTNET-ONLY: emitted when `adminResetSlot` wipes a user's per-account
    /// commitment back to the identity point. PRIVACY-BREAKING side effect:
    /// observers learn that `user` had a stuck/abandoned slot AND that any
    /// future commitment they publish is fresh (no homomorphic baggage).
    event AdminSlotReset(
        address indexed user,
        uint256 priorCommitmentX,
        uint256 priorCommitmentY
    );

    // -----------------------------------------------------------------------
    // Initializer
    // -----------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-shot initializer for the abstract base.
    /// Concrete tokens MUST call this from their own `initialize`.
    function __JanusToken_init(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _owner
    ) internal onlyInitializing {
        require(_babyJub                != address(0), "JanusToken: zero babyJub");
        require(_transferVerifier       != address(0), "JanusToken: zero transferVerifier");
        require(_amountDiscloseVerifier != address(0), "JanusToken: zero amountDiscloseVerifier");
        require(_owner                  != address(0), "JanusToken: zero owner");

        __Ownable_init(_owner);
        __UUPSUpgradeable_init();

        babyJub                = IBabyJub(_babyJub);
        transferVerifier       = IConfidentialTransferVerifier(_transferVerifier);
        amountDiscloseVerifier = IAmountDiscloseVerifier(_amountDiscloseVerifier);

        totalSupplyCommitment = Point({ x: 0, y: 1 });
    }

    /// @dev UUPS upgrade authorization — owner only.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -----------------------------------------------------------------------
    // !!! TESTNET-ONLY — REMOVE BEFORE MAINNET !!!
    //
    // See MAINNET-PREPARE-CHECKLIST.md (entry 1) in the package root.
    // The chainid guard below makes this inert on any chain != 545, but a
    // mainnet build MUST delete the function entirely (or replace with a
    // time-locked + governance-gated variant) to avoid shipping a
    // privacy-breaking escape hatch.
    //
    // adminResetSlot — TESTNET-ONLY commitment recovery
    // -----------------------------------------------------------------------
    //
    // TESTNET-ONLY function for recovering slots that have become unusable
    // because a client wrote a commitment without retaining the corresponding
    // blinding factor (so the next `shieldedTransfer` proof can never match
    // the on-chain `C_old`).
    //
    // WARNING — PRIVACY-BREAKING. This function:
    //   * lets the contract owner zero out ANY user's per-account commitment;
    //   * leaks (via the AdminSlotReset event) the prior commitment point;
    //   * intentionally does NOT touch totalSupplyCommitment, so the homomorphic
    //     invariant `totalSupplyCommitment == sum(commitments[a])` is BROKEN
    //     after a reset. The shielded pool's audit trail no longer balances.
    //
    // The chainid guard hardcodes Flow EVM testnet (chainId 545) and reverts on
    // any other chain. Removing or weakening that check before mainnet
    // deployment would silently hand the owner an arbitrary commitment-wipe
    // capability.

    /// Flow EVM testnet chain id (https://developers.flow.com/evm/networks).
    uint256 private constant FLOW_EVM_TESTNET_CHAIN_ID = 545;

    /// @notice TESTNET-ONLY: reset `user`'s commitment slot to the identity
    /// point so they can wrap fresh with a brand-new blinding chain.
    /// @dev PRIVACY-BREAKING — must never be deployable on mainnet. The
    /// `require(block.chainid == 545)` guard reverts every call on any chain
    /// other than Flow EVM testnet (chainId 545), so even if this impl is
    /// accidentally pointed at mainnet via a proxy upgrade, the function is
    /// inert. The owner check is enforced by `onlyOwner`.
    ///
    /// Side effects:
    ///   * `commitments[user]` is overwritten with identity (0, 1).
    ///   * `totalSupplyCommitment` is INTENTIONALLY NOT updated — the protocol
    ///     invariant is broken on purpose; this is a recovery-only escape
    ///     hatch, not a normal-path operation.
    ///   * `totalLocked` is INTENTIONALLY NOT updated — the underlying asset
    ///     custody is independent of per-account commitments.
    function adminResetSlot(address user) external virtual onlyOwner {
        require(
            block.chainid == FLOW_EVM_TESTNET_CHAIN_ID,
            "JanusToken: adminResetSlot is testnet-only (chainId 545)"
        );
        require(user != address(0), "JanusToken: zero user");

        Point storage slot = commitments[user];
        uint256 priorX = slot.x;
        uint256 priorY = slot.y;

        slot.x = 0;
        slot.y = 1;

        emit AdminSlotReset(user, priorX, priorY);
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

    function _effectiveCommitment(address account) internal view returns (Point memory) {
        Point memory c = commitments[account];
        if (c.x == 0 && c.y == 0) {
            return Point({ x: 0, y: 1 });
        }
        return c;
    }

    // -----------------------------------------------------------------------
    // shieldedTransfer — concrete; amount HIDDEN on calldata, events, storage
    // -----------------------------------------------------------------------

    /// @notice Move a hidden amount from `msg.sender` to `to`.
    /// @dev    Public inputs layout (uint256[6]):
    ///         [0..1] C_old   — sender's current commitment (must match storage)
    ///         [2..3] C_tx    — Pedersen commit of the transferred amount
    ///         [4..5] C_new   — sender's new commitment (C_old − C_tx)
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

        // Sender commitment becomes C_new
        commitments[msg.sender] = Point({ x: publicInputs[4], y: publicInputs[5] });

        // Recipient commitment += C_tx (homomorphic)
        Point memory recvCommit = _effectiveCommitment(to);
        (uint256 rx, uint256 ry) = babyJub.babyAdd(
            recvCommit.x, recvCommit.y,
            publicInputs[2], publicInputs[3]
        );
        commitments[to] = Point({ x: rx, y: ry });

        emit ConfidentialTransfer(msg.sender, to);
    }

    // -----------------------------------------------------------------------
    // Abstract template-method hooks for wrap/unwrap
    //
    // Concrete tokens override these to take/release custody of the
    // underlying asset (native FLOW, ERC-20, etc.). The shielded credit /
    // debit accounting is provided by `_acceptShieldedCredit` and
    // `_processShieldedDebit` below — concrete impls call them once they
    // have verified the relevant proofs.
    // -----------------------------------------------------------------------

    function _wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof
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
    // Internal helpers — proof verification + commitment book-keeping
    // -----------------------------------------------------------------------

    function _verifyAmountDisclose(
        uint256 claimedAmount,
        uint256[2] calldata commit,
        uint256[8] calldata proof
    ) internal view returns (bool) {
        return amountDiscloseVerifier.verifyProof(
            [proof[0], proof[1]],
            [[proof[2], proof[3]], [proof[4], proof[5]]],
            [proof[6], proof[7]],
            [claimedAmount, commit[0], commit[1]]
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

    /// @dev Credit `account` with the commitment `txCommit` after an
    /// `_wrap` flow has verified the amount-disclose proof. Updates the
    /// per-account commitment AND the total-supply commitment homomorphically.
    function _acceptShieldedCredit(
        address account,
        uint256[2] calldata txCommit
    ) internal {
        Point memory current = _effectiveCommitment(account);
        (uint256 nx, uint256 ny) = babyJub.babyAdd(
            current.x, current.y,
            txCommit[0], txCommit[1]
        );
        commitments[account] = Point({ x: nx, y: ny });

        (uint256 sx, uint256 sy) = babyJub.babyAdd(
            totalSupplyCommitment.x, totalSupplyCommitment.y,
            txCommit[0], txCommit[1]
        );
        totalSupplyCommitment = Point({ x: sx, y: sy });
    }

    /// @dev Debit `account` of the commitment encoded by the verified
    /// transfer-proof bundle. Caller MUST have already verified the
    /// AmountDisclose proof, the transfer proof, AND the consistency
    /// invariants between them (`C_old == account's commitment`,
    /// `C_tx == txCommit`).
    function _processShieldedDebit(
        address account,
        uint256[2] calldata txCommit,
        uint256[6] calldata transferPublicInputs
    ) internal {
        // Account → C_new
        commitments[account] = Point({
            x: transferPublicInputs[4],
            y: transferPublicInputs[5]
        });

        // totalSupplyCommitment -= txCommit  (== add the negation)
        (uint256 negX, uint256 negY) = babyJub.negate(txCommit[0], txCommit[1]);
        (uint256 sx, uint256 sy) = babyJub.babyAdd(
            totalSupplyCommitment.x, totalSupplyCommitment.y,
            negX, negY
        );
        totalSupplyCommitment = Point({ x: sx, y: sy });
    }
}
