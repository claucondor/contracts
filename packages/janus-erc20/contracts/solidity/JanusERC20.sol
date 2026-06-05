// SPDX-License-Identifier: MIT
// EXPERIMENTAL — NOT AUDITED — DO NOT USE FOR PRODUCTION
//
// JanusERC20.sol — Confidential ERC20 wrapper (v0.7.0).
// Inherits JanusToken v0.7.0 (aggregate commitment upgrade).
//
// Changes from v0.5.0:
//   - Uses 2-generator Pedersen commitment (pedersen2Gen.addCommits) for
//     all accumulator updates — correct homomorphism after N deposits
//   - Accepts pedersen2Gen address in initializer
//   - VERSION bumped to 0.7.0

pragma solidity ^0.8.20;

import {JanusToken} from "./JanusToken.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IMemoKeyRegistryV2 {
    function getMemoKey(address user)
        external
        view
        returns (uint256 x, uint256 y, uint256 publishedAt);
}

contract JanusERC20 is JanusToken {

    string  public constant VERSION  = "0.7.0";
    uint256 public constant MAX_WRAP = 18_000_000_000_000_000_000;

    // -----------------------------------------------------------------------
    // Storage — slots after JanusToken base
    // -----------------------------------------------------------------------

    /// underlying ERC20 token
    address public underlying;

    /// first block a user appeared in a snapshot event
    mapping(address => uint256) public firstSnapshotBlock;

    /// fee destination address
    address public feeRecipient;

    /// fee basis points (100 = 1%, max 100)
    uint16  public feeBps;

    /// shared MemoKeyRegistry
    IMemoKeyRegistryV2 public memoRegistry;

    /// reserved
    uint256[35] private __gapERC20;

    // -----------------------------------------------------------------------
    // Fee constants
    // -----------------------------------------------------------------------

    uint16 public constant MAX_FEE_BPS = 100;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

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

    event FeeCollected(address indexed user, uint256 fee, string op);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeeBpsChanged(uint16 oldBps, uint16 newBps);
    event MemoRegistrySet(address indexed registry);
    event AdminSlotReset(
        address indexed user,
        uint256 priorCommitmentX,
        uint256 priorCommitmentY
    );

    // -----------------------------------------------------------------------
    // Initializer — for NEW proxies
    // -----------------------------------------------------------------------

    function initialize(
        address _babyJub,
        address _transferVerifier,
        address _amountDiscloseVerifier,
        address _underlying,
        address _owner,
        address _memoRegistry,
        address _pedersen2Gen
    ) external initializer {
        require(_underlying   != address(0), "JanusERC20: zero underlying");
        require(_memoRegistry != address(0), "JanusERC20: zero memoRegistry");
        __JanusToken_init(_babyJub, _transferVerifier, _amountDiscloseVerifier, _owner, _pedersen2Gen);
        underlying   = _underlying;
        memoRegistry = IMemoKeyRegistryV2(_memoRegistry);
    }

    // -----------------------------------------------------------------------
    // Admin — post-deploy setters (owner-only)
    // -----------------------------------------------------------------------

    function setMemoRegistry(address _registry) external onlyOwner {
        require(_registry != address(0), "JanusERC20: zero registry");
        memoRegistry = IMemoKeyRegistryV2(_registry);
        emit MemoRegistrySet(_registry);
    }

    function initFees(address recipient, uint16 bps) external onlyOwner {
        require(
            feeRecipient == address(0) && feeBps == 0,
            "JanusERC20: fees already initialized"
        );
        require(recipient != address(0), "JanusERC20: zero feeRecipient");
        require(bps <= MAX_FEE_BPS,     "JanusERC20: exceeds MAX_FEE_BPS");
        feeRecipient = recipient;
        feeBps = bps;
        emit FeeRecipientChanged(address(0), recipient);
        emit FeeBpsChanged(0, bps);
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "JanusERC20: zero feeRecipient");
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientChanged(old, newRecipient);
    }

    function setFeeBps(uint16 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "JanusERC20: exceeds MAX_FEE_BPS");
        uint16 old = feeBps;
        feeBps = newBps;
        emit FeeBpsChanged(old, newBps);
    }

    function computeFee(uint256 grossAmount) public view returns (uint256) {
        if (feeBps == 0 || feeRecipient == address(0)) return 0;
        return (grossAmount * feeBps) / 10000;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    function _recordFirstSnapshot(address account) internal {
        if (firstSnapshotBlock[account] == 0) {
            firstSnapshotBlock[account] = block.number;
        }
    }

    function _calcFee(uint256 grossAmount) internal view returns (uint256 fee, uint256 net) {
        if (feeBps == 0 || feeRecipient == address(0)) {
            return (0, grossAmount);
        }
        fee = (grossAmount * feeBps) / 10000;
        net = grossAmount - fee;
    }

    // -----------------------------------------------------------------------
    // Public wrap
    // -----------------------------------------------------------------------

    function wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external {
        require(amount > 0, "JanusERC20: zero wrap");
        _recordFirstSnapshot(msg.sender);

        bool okPull = IERC20(underlying).transferFrom(msg.sender, address(this), amount);
        require(okPull, "JanusERC20: transferFrom failed");

        (uint256 fee, uint256 net) = _calcFee(amount);

        if (fee > 0) {
            bool okFee = IERC20(underlying).transfer(feeRecipient, fee);
            require(okFee, "JanusERC20: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "wrap");
        }

        _wrap(net, txCommit, amountProof);

        emit WrapWithSnapshot(msg.sender, net, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    // -----------------------------------------------------------------------
    // Public unwrap
    // -----------------------------------------------------------------------

    function unwrap(
        uint256 claimedAmount,
        address payable recipient,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        uint256[6] calldata transferPublicInputs,
        uint256[8] calldata transferProof,
        bytes calldata encryptedSnapshot,
        uint256 ephPubkeyX,
        uint256 ephPubkeyY
    ) external {
        _recordFirstSnapshot(msg.sender);
        _unwrap(claimedAmount, recipient, txCommit, amountProof, transferPublicInputs, transferProof);
        emit UnwrapWithSnapshot(msg.sender, recipient, claimedAmount, encryptedSnapshot, ephPubkeyX, ephPubkeyY);
    }

    // -----------------------------------------------------------------------
    // 9-arg shieldedTransfer (SDK v0.6.3+ compatible selector 0x6218f5d9)
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
        require(to != address(0), "JanusERC20: transfer to zero address");
        require(to != msg.sender, "JanusERC20: cannot transfer to self");

        _recordFirstSnapshot(msg.sender);
        _recordFirstSnapshot(to);

        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            publicInputs[0] == senderCommit.x && publicInputs[1] == senderCommit.y,
            "JanusERC20: C_old mismatch"
        );

        require(
            _verifyTransferProof(publicInputs, proof),
            "JanusERC20: invalid transfer proof"
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
        emit ShieldedTransferWithSnapshot(
            msg.sender, to,
            encryptedSnapshot, ephPubkeyX, ephPubkeyY,
            encryptedNoteTo, ephPubkeyToX, ephPubkeyToY
        );
    }

    // -----------------------------------------------------------------------
    // Template-method overrides
    // -----------------------------------------------------------------------

    function _wrap(
        uint256 amount,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof
    ) internal override {
        require(amount > 0,         "JanusERC20: zero net wrap");
        require(amount <= MAX_WRAP, "JanusERC20: exceeds MAX_WRAP");

        require(
            _verifyAmountDisclose(amount, txCommit, amountProof),
            "JanusERC20: invalid amount_disclose proof"
        );

        _acceptShieldedCredit(msg.sender, txCommit);
        totalLocked += amount;

        emit Wrapped(msg.sender, amount);
    }

    function _unwrap(
        uint256 claimedAmount,
        address payable recipient,
        uint256[2] calldata txCommit,
        uint256[8] calldata amountProof,
        uint256[6] calldata transferPublicInputs,
        uint256[8] calldata transferProof
    ) internal override {
        require(claimedAmount > 0,            "JanusERC20: zero unwrap");
        require(recipient != address(0),      "JanusERC20: zero recipient");
        require(totalLocked >= claimedAmount, "JanusERC20: pool exhausted");

        require(
            _verifyAmountDisclose(claimedAmount, txCommit, amountProof),
            "JanusERC20: invalid amount_disclose proof"
        );

        Point memory senderCommit = _effectiveCommitment(msg.sender);
        require(
            transferPublicInputs[0] == senderCommit.x &&
            transferPublicInputs[1] == senderCommit.y,
            "JanusERC20: C_old mismatch"
        );

        require(
            transferPublicInputs[2] == txCommit[0] &&
            transferPublicInputs[3] == txCommit[1],
            "JanusERC20: C_tx mismatch between proofs"
        );

        require(
            _verifyTransferProof(transferPublicInputs, transferProof),
            "JanusERC20: invalid transfer proof"
        );

        _processShieldedDebit(msg.sender, txCommit, transferPublicInputs);

        totalLocked -= claimedAmount;

        (uint256 fee, uint256 netToRecipient) = _calcFee(claimedAmount);

        if (fee > 0) {
            bool okFee = IERC20(underlying).transfer(feeRecipient, fee);
            require(okFee, "JanusERC20: fee transfer failed");
            emit FeeCollected(msg.sender, fee, "unwrap");
        }

        bool okSend = IERC20(underlying).transfer(recipient, netToRecipient);
        require(okSend, "JanusERC20: transfer failed");

        emit Unwrapped(msg.sender, recipient, netToRecipient);
    }

    // -----------------------------------------------------------------------
    // TESTNET-ONLY — adminResetSlot
    // -----------------------------------------------------------------------

    uint256 private constant FLOW_EVM_TESTNET_CHAIN_ID = 545;

    function adminResetSlot(address user) external onlyOwner {
        require(
            block.chainid == FLOW_EVM_TESTNET_CHAIN_ID,
            "JanusERC20: adminResetSlot is testnet-only (chainId 545)"
        );
        require(user != address(0), "JanusERC20: zero user");

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

    function underlyingBalance() external view returns (uint256) {
        return IERC20(underlying).balanceOf(address(this));
    }

    function getMemoKeyFromRegistry(address user)
        public
        view
        returns (uint256 x, uint256 y)
    {
        require(address(memoRegistry) != address(0), "JanusERC20: memoRegistry not set");
        (x, y, ) = memoRegistry.getMemoKey(user);
    }
}

// ---------------------------------------------------------------------------
// JanusERC20_Proxy — thin ERC1967 wrapper.
// ---------------------------------------------------------------------------

contract JanusERC20_Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data)
    {}
}
