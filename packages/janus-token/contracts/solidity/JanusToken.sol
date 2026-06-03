// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusToken.sol — Abstract base for all Janus confidential tokens.
//
// Track B++ architectural fix: replaces per-token memoKeyPubX/memoKeyPubY
// mappings with a shared MemoKeyRegistry contract.  All Janus EVM tokens now
// read from one source of truth.  SDK routes publishMemoKey() calls directly
// to the registry; the Janus token no longer exposes publishMemoKey() itself.
//
// STORAGE LAYOUT — CRITICAL — UUPS COMPATIBILITY
// -----------------------------------------------
// The live proxies (JanusFlow / JanusWFLOW / JanusMockUSDC) were deployed with
// JanusToken_v0_6 layout (fresh-deploy single-gap):
//
//   slot  0    babyJub                  address
//   slot  1    transferVerifier         address
//   slot  2    amountDiscloseVerifier   address
//   slot  3    commitments              mapping(address => Point)
//   slot  4-5  totalSupplyCommitment    Point
//   slot  6    totalLocked              uint256
//   slot  7    memoKeyPubX              mapping(address => uint256)   <= DEPRECATED
//   slot  8    memoKeyPubY              mapping(address => uint256)   <= DEPRECATED
//   slot  9    firstSnapshotBlock       mapping(address => uint256)
//   slot 10    feeRecipient + feeBps    packed (address 20B + uint16 2B)
//   slot 11..90  __gap[80]              uint256[80]
//
// SLOTS 7 AND 8 ARE PRESERVED (declared as DEPRECATED mappings).
// DO NOT REMOVE or reorder them — UUPS storage layout must be byte-compatible.
// New state (memoRegistry) is appended at the tail of __gap, shrinking __gap
// from [80] to [79] (one slot consumed).  This is the safe, canonical OZ
// pattern for adding state to upgraded implementations.
//
// After v0.6.3 upgrade the __gap occupies slots 11..89 (79 slots) and
// memoRegistry occupies slot 90.
//
// VERIFYING SLOT 90:
//   In JanusToken_v0_6: base __gap[80] spans slots 11..90
//                        (11 + 80 - 1 = 90, zero-indexed = 11 to 90).
//   In JanusToken_v0_6_3: __gap[79] spans slots 11..89; memoRegistry at 90.
//   Both leave slots 0..90 occupied; concrete subclasses continue at slot 91+.
//
// Concrete subclasses MUST NOT add state between the base slots and their own
// first variable — the gap absorbs additions.
//
// UPGRADE PATTERN (for 3 proxies):
//   1. Deploy new JanusFlow_v0_6_3 / JanusERC20_v0_6_3 impl (no init needed).
//   2. Call proxy.upgradeToAndCall(newImpl, "0x") from proxy owner COA.
//   3. After upgrade, memoRegistry auto-reads from slot 90 — but slot 90 was
//      part of the old __gap and is zero.  Therefore memoRegistry starts as
//      address(0) until we call _setMemoRegistry().
//   4. Call setMemoRegistry(MEMO_REGISTRY_ADDRESS) from owner (one-shot or
//      mutable setter with owner guard).
//
// Note: _setMemoRegistry is a separate owner-only call post-upgrade, not part
// of upgradeToAndCall, because UUPS upgradeToAndCall data would need to be
// signed by the COA owner and the encoding is straightforward to do separately.

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

// ---------------------------------------------------------------------------
// JanusToken_v0_6_3 — abstract base (B++ upgrade)
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
    // Storage — must be byte-compatible with JanusToken_v0_6 layout.
    //
    //   slot  0  babyJub
    //   slot  1  transferVerifier
    //   slot  2  amountDiscloseVerifier
    //   slot  3  commitments
    //   slot  4  totalSupplyCommitment.x
    //   slot  5  totalSupplyCommitment.y
    //   slot  6  totalLocked
    //   slot  7  memoKeyPubX   DEPRECATED: read from memoRegistry instead
    //   slot  8  memoKeyPubY   DEPRECATED: read from memoRegistry instead
    //   slot  9  firstSnapshotBlock
    //   slot 10  feeRecipient (20B) + feeBps (2B)  packed
    //   slot 11..89  __gap[79]
    //   slot 90  memoRegistry   <-- NEW in v0.6.3 (tail of former __gap[80])
    //
    // Concrete subclasses (JanusERC20_v0_6_3, JanusFlow_v0_6_3) continue at
    // slot 91+ (same as in v0.6 — no shift).
    // -----------------------------------------------------------------------

    IBabyJub                       public babyJub;                  // slot 0
    IConfidentialTransferVerifier  public transferVerifier;         // slot 1
    IAmountDiscloseVerifier        public amountDiscloseVerifier;   // slot 2

    mapping(address => Point) public commitments;                   // slot 3

    Point public totalSupplyCommitment;                             // slot 4-5

    uint256 public totalLocked;                                     // slot 6

    // DEPRECATED: these mappings are NOT removed — slots 7 and 8 must stay
    // in the same position for UUPS storage compatibility with the live proxies.
    // Existing legacy data in these slots is orphaned (ignored by v0.6.3 logic).
    // New memo key data is read exclusively from memoRegistry (slot 90).
    mapping(address => uint256) public memoKeyPubX; // slot 7 — DEPRECATED
    mapping(address => uint256) public memoKeyPubY; // slot 8 — DEPRECATED

    mapping(address => uint256) public firstSnapshotBlock;          // slot 9

    address public feeRecipient;                                    // slot 10, offset 0
    uint16  public feeBps;                                          // slot 10, offset 20

    /// Reserved storage — shrunk from [80] to [79] to accommodate memoRegistry.
    uint256[79] private __gap;                                      // slot 11..89

    /// Shared MemoKeyRegistry — single source of truth for all Janus EVM tokens.
    /// Occupies slot 90 (formerly the last slot of __gap[80]).
    IMemoKeyRegistry public memoRegistry;                           // slot 90

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

    /// Emitted when the shared registry address is configured.
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
    // Initializer (for new proxies — not used in UUPS upgrade path)
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
        address _memoRegistry
    ) internal onlyInitializing {
        require(_babyJub                != address(0), "JanusToken: zero babyJub");
        require(_transferVerifier       != address(0), "JanusToken: zero transferVerifier");
        require(_amountDiscloseVerifier != address(0), "JanusToken: zero amountDiscloseVerifier");
        require(_owner                  != address(0), "JanusToken: zero owner");
        require(_memoRegistry           != address(0), "JanusToken: zero memoRegistry");

        __Ownable_init(_owner);
        __UUPSUpgradeable_init();

        babyJub                = IBabyJub(_babyJub);
        transferVerifier       = IConfidentialTransferVerifier(_transferVerifier);
        amountDiscloseVerifier = IAmountDiscloseVerifier(_amountDiscloseVerifier);
        memoRegistry           = IMemoKeyRegistry(_memoRegistry);

        totalSupplyCommitment = Point({ x: 0, y: 1 });
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // -----------------------------------------------------------------------
    // Registry admin
    //
    // setMemoRegistry is the post-upgrade setter called by the proxy owner
    // after upgradeToAndCall completes (slot 90 is zero until this is called).
    // -----------------------------------------------------------------------

    /// @notice Configure (or update) the shared MemoKeyRegistry address.
    /// @dev Owner-only.  Called once after UUPS upgrade to wire in the registry.
    function setMemoRegistry(address _registry) external onlyOwner {
        require(_registry != address(0), "JanusToken: zero registry");
        memoRegistry = IMemoKeyRegistry(_registry);
        emit MemoRegistrySet(_registry);
    }

    // -----------------------------------------------------------------------
    // MemoKey READ helper (replaces direct mapping reads)
    // -----------------------------------------------------------------------

    /// @notice Read the caller's registered BabyJub pubkey from the shared registry.
    /// @dev Returns (0,0) if not registered.
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

    function _effectiveCommitment(address account) internal view returns (Point memory) {
        Point memory c = commitments[account];
        if (c.x == 0 && c.y == 0) {
            return Point({ x: 0, y: 1 });
        }
        return c;
    }

    // -----------------------------------------------------------------------
    // shieldedTransfer — reads memo key from registry for recipient note
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

        commitments[msg.sender] = Point({ x: publicInputs[4], y: publicInputs[5] });

        Point memory recvCommit = _effectiveCommitment(to);
        (uint256 rx, uint256 ry) = babyJub.babyAdd(
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
        (uint256 sx, uint256 sy) = babyJub.babyAdd(
            totalSupplyCommitment.x, totalSupplyCommitment.y,
            negX, negY
        );
        totalSupplyCommitment = Point({ x: sx, y: sy });
    }
}
