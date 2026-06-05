// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusToken.sol — Abstract base for all Janus confidential tokens.
//
// v0.7.0 — 2-generator Pedersen aggregate commitment upgrade
//
// This version replaces the windowed-Pedersen accumulator path with the
// classical 2-generator commitment scheme:
//
//   Commit(v, r) := [v]·G + [r]·H
//
// This is homomorphic: Commit(v1,r1) + Commit(v2,r2) = Commit(v1+v2, r1+r2)
// so the on-chain accumulator correctly tracks accumulated deposits after N wraps.
//
// The `pedersen2Gen` contract handles all accumulator arithmetic via addCommits().
// The `babyJub` contract is retained for the negate() call in _processShieldedDebit.
//
// STORAGE LAYOUT — CRITICAL — UUPS COMPATIBILITY
// -----------------------------------------------
// This is a FRESH deploy layout (new proxies, not upgrades of v0.6.x proxies).
//
//   slot  0    babyJub                  address
//   slot  1    transferVerifier         address
//   slot  2    amountDiscloseVerifier   address
//   slot  3    commitments              mapping(address => Point)
//   slot  4-5  totalSupplyCommitment    Point
//   slot  6    totalLocked              uint256
//   slot  7    memoKeyPubX              mapping  (DEPRECATED — slot kept)
//   slot  8    memoKeyPubY              mapping  (DEPRECATED — slot kept)
//   slot  9    firstSnapshotBlock       mapping(address => uint256)
//   slot 10    feeRecipient + feeBps    packed
//   slot 11..89  __gap[79]             uint256[79]
//   slot 90    memoRegistry             address
//   slot 91    pedersen2Gen             address  <-- NEW in v0.7.0

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

interface IAmountDiscloseVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[3] calldata _pubSignals
    ) external view returns (bool);
}

interface IMemoKeyRegistry {
    function getMemoKey(address user)
        external
        view
        returns (uint256 x, uint256 y, uint256 publishedAt);
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
    // Storage — slot-stable layout
    //
    //   slot  0  babyJub
    //   slot  1  transferVerifier
    //   slot  2  amountDiscloseVerifier
    //   slot  3  commitments
    //   slot  4  totalSupplyCommitment.x
    //   slot  5  totalSupplyCommitment.y
    //   slot  6  totalLocked
    //   slot  7  memoKeyPubX   DEPRECATED: read from memoRegistry
    //   slot  8  memoKeyPubY   DEPRECATED: read from memoRegistry
    //   slot  9  firstSnapshotBlock
    //   slot 10  feeRecipient (20B) + feeBps (2B)  packed
    //   slot 11..89  __gap[79]
    //   slot 90  memoRegistry
    //   slot 91  pedersen2Gen   <-- NEW
    // -----------------------------------------------------------------------

    IBabyJub                       public babyJub;                  // slot 0
    IConfidentialTransferVerifier  public transferVerifier;         // slot 1
    IAmountDiscloseVerifier        public amountDiscloseVerifier;   // slot 2

    mapping(address => Point) public commitments;                   // slot 3

    Point public totalSupplyCommitment;                             // slot 4-5

    uint256 public totalLocked;                                     // slot 6

    // DEPRECATED: slots 7 and 8 kept for layout stability.
    mapping(address => uint256) public memoKeyPubX; // slot 7 — DEPRECATED
    mapping(address => uint256) public memoKeyPubY; // slot 8 — DEPRECATED

    mapping(address => uint256) public firstSnapshotBlock;          // slot 9

    address public feeRecipient;                                    // slot 10, offset 0
    uint16  public feeBps;                                          // slot 10, offset 20

    /// Reserved storage gap
    uint256[79] private __gap;                                      // slot 11..89

    /// Shared MemoKeyRegistry — single source of truth for all Janus EVM tokens.
    IMemoKeyRegistry public memoRegistry;                           // slot 90

    /// 2-generator Pedersen commitment library — homomorphic accumulator.
    IPedersen2Gen    public pedersen2Gen;                           // slot 91

    // -----------------------------------------------------------------------
    // Fee constants
    // -----------------------------------------------------------------------

    uint16 public constant MAX_FEE_BPS = 100;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event Wrapped(address indexed user, uint256 amount);
    event Unwrapped(address indexed user, address indexed recipient, uint256 amount);
    event ConfidentialTransfer(address indexed from, address indexed to);

    event MemoRegistrySet(address indexed registry);

    event WrapWithSnapshot(
        address indexed user,
        uint256 amount,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    event ShieldedTransferWithSnapshot(
        address indexed from,
        address indexed to,
        bytes encryptedSnapshotFrom,
        uint256 ephPubkeyFromX,
        uint256 ephPubkeyFromY,
        bytes encryptedNoteTo,
        uint256 ephPubkeyToX,
        uint256 ephPubkeyToY
    );

    event UnwrapWithSnapshot(
        address indexed user,
        address indexed recipient,
        uint256 amount,
        bytes encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    );

    event AdminSlotReset(
        address indexed user,
        uint256 priorCommitmentX,
        uint256 priorCommitmentY
    );

    event FeeCollected(address indexed user, uint256 fee, string op);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeeBpsChanged(uint16 oldBps, uint16 newBps);

    // -----------------------------------------------------------------------
    // Initializer (for new proxies)
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
        address _memoRegistry,
        address _pedersen2Gen
    ) internal onlyInitializing {
        require(_babyJub                != address(0), "JanusToken: zero babyJub");
        require(_transferVerifier       != address(0), "JanusToken: zero transferVerifier");
        require(_amountDiscloseVerifier != address(0), "JanusToken: zero amountDiscloseVerifier");
        require(_owner                  != address(0), "JanusToken: zero owner");
        require(_memoRegistry           != address(0), "JanusToken: zero memoRegistry");
        require(_pedersen2Gen           != address(0), "JanusToken: zero pedersen2Gen");

        __Ownable_init(_owner);
        __UUPSUpgradeable_init();

        babyJub                = IBabyJub(_babyJub);
        transferVerifier       = IConfidentialTransferVerifier(_transferVerifier);
        amountDiscloseVerifier = IAmountDiscloseVerifier(_amountDiscloseVerifier);
        memoRegistry           = IMemoKeyRegistry(_memoRegistry);
        pedersen2Gen           = IPedersen2Gen(_pedersen2Gen);

        totalSupplyCommitment = Point({ x: 0, y: 1 });
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -----------------------------------------------------------------------
    // Registry admin
    // -----------------------------------------------------------------------

    function setMemoRegistry(address _registry) external onlyOwner {
        require(_registry != address(0), "JanusToken: zero registry");
        memoRegistry = IMemoKeyRegistry(_registry);
        emit MemoRegistrySet(_registry);
    }

    // -----------------------------------------------------------------------
    // MemoKey READ helper
    // -----------------------------------------------------------------------

    function getMemoKeyFromRegistry(address user)
        public
        view
        returns (uint256 x, uint256 y)
    {
        require(address(memoRegistry) != address(0), "JanusToken: memoRegistry not set");
        (x, y, ) = memoRegistry.getMemoKey(user);
    }

    // -----------------------------------------------------------------------
    // Internal snapshot-block helper
    // -----------------------------------------------------------------------

    function _recordFirstSnapshot(address account) internal {
        if (firstSnapshotBlock[account] == 0) {
            firstSnapshotBlock[account] = block.number;
        }
    }

    // -----------------------------------------------------------------------
    // Fee admin
    // -----------------------------------------------------------------------

    function initFees(address recipient, uint16 bps) external onlyOwner {
        require(
            feeRecipient == address(0) && feeBps == 0,
            "JanusToken: fees already initialized"
        );
        require(recipient != address(0), "JanusToken: zero feeRecipient");
        require(bps <= MAX_FEE_BPS, "JanusToken: exceeds MAX_FEE_BPS");
        feeRecipient = recipient;
        feeBps = bps;
        emit FeeRecipientChanged(address(0), recipient);
        emit FeeBpsChanged(0, bps);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "JanusToken: zero feeRecipient");
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientChanged(old, newRecipient);
    }

    function setFeeBps(uint16 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "JanusToken: exceeds MAX_FEE_BPS");
        uint16 old = feeBps;
        feeBps = newBps;
        emit FeeBpsChanged(old, newBps);
    }

    function computeFee(uint256 grossAmount) public view returns (uint256) {
        if (feeBps == 0 || feeRecipient == address(0)) return 0;
        return (grossAmount * feeBps) / 10000;
    }

    function _calcFee(uint256 grossAmount) internal view returns (uint256 fee, uint256 net) {
        if (feeBps == 0 || feeRecipient == address(0)) {
            return (0, grossAmount);
        }
        fee = (grossAmount * feeBps) / 10000;
        net = grossAmount - fee;
    }

    // -----------------------------------------------------------------------
    // TESTNET-ONLY — adminResetSlot
    // -----------------------------------------------------------------------

    uint256 private constant FLOW_EVM_TESTNET_CHAIN_ID = 545;

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

        firstSnapshotBlock[user] = 0;

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

    /// @dev Converts uninitialised storage (0, 0) to the BabyJubJub identity (0, 1).
    function _effectiveCommitment(address account) internal view returns (Point memory) {
        Point memory c = commitments[account];
        if (c.x == 0 && c.y == 0) {
            return Point({ x: 0, y: 1 });
        }
        return c;
    }

    // -----------------------------------------------------------------------
    // shieldedTransfer — 9-arg signature compatible with SDK v0.6.3+
    // -----------------------------------------------------------------------

    function shieldedTransfer(
        address to,
        uint256[6] calldata publicInputs,
        uint256[8] calldata proof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY,
        bytes calldata encryptedNoteTo,
        uint256 ephPubkeyToX,
        uint256 ephPubkeyToY
    ) external {
        require(to != address(0), "JanusToken: transfer to zero address");
        require(to != msg.sender, "JanusToken: cannot transfer to self");

        _recordFirstSnapshot(msg.sender);
        _recordFirstSnapshot(to);

        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            publicInputs[0] == senderCommit.x && publicInputs[1] == senderCommit.y,
            "JanusToken: C_old mismatch"
        );

        require(
            _verifyTransferProof(publicInputs, proof),
            "JanusToken: invalid transfer proof"
        );

        // Sender: set new_commit from proof output
        commitments[msg.sender] = Point({ x: publicInputs[4], y: publicInputs[5] });

        // Recipient: accumulate transfer_commit using homomorphic addition
        Point memory recvCommit = _effectiveCommitment(to);
        (uint256 rx, uint256 ry) = pedersen2Gen.addCommits(
            recvCommit.x, recvCommit.y,
            publicInputs[2], publicInputs[3]
        );
        commitments[to] = Point({ x: rx, y: ry });

        emit ConfidentialTransfer(msg.sender, to);
        emit ShieldedTransferWithSnapshot(
            msg.sender, to,
            encryptedSnapshot, ephPubkeyX, ephPubkeyY,
            encryptedNoteTo, ephPubkeyToX, ephPubkeyToY
        );
    }

    // -----------------------------------------------------------------------
    // Abstract template-method hooks
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
    // Internal helpers
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

    /// @dev Accumulate txCommit into account's shielded balance.
    /// Uses pedersen2Gen.addCommits for homomorphic accumulation.
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
