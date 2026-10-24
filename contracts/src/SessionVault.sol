// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {FeeCollector} from "./FeeCollector.sol";
import {IPlanFactory} from "./interfaces/IPlanFactory.sol";

/// @title SessionVault
/// @notice Prepaid sessions for agent payments. An owner deposits stablecoins and names a session
///         signer; for each paid request the signer gives the payee a cumulative EIP-712 voucher
///         off-chain. Anyone can redeem the latest voucher, which pays out only what is new since
///         the last redemption: b(t+1) = b(t) - r * delta(t), and a call is payable while b(t) >= r.
/// @dev The owner can only take funds back after a close delay, which gives payees time to
///      redeem vouchers they have accepted. A leaked signer key can spend at most the balance.
contract SessionVault is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    EIP712Upgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @dev Three storage slots; owner and balance share the first.
    struct Session {
        address owner;
        uint96 balance;
        address signer;
        uint40 expiresAt;
        uint40 closesAt;
        address token;
    }

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 sessionId,address payee,uint256 cumulativeAmount)");
    uint32 public constant MIN_CLOSE_DELAY = 5 minutes;
    uint32 public constant MAX_CLOSE_DELAY = 7 days;

    IPlanFactory public planFactory;
    FeeCollector public feeCollector;
    /// @notice Time payees get to redeem vouchers after a session expires or its owner asks to close.
    uint32 public closeDelay;

    mapping(bytes32 sessionId => Session) private _sessions;
    /// @notice Cumulative amount already paid out to each payee of a session.
    mapping(bytes32 sessionId => mapping(address payee => uint256)) public redeemed;
    mapping(address owner => uint256) public sessionCount;

    event SessionOpened(
        bytes32 indexed sessionId,
        address indexed owner,
        address indexed signer,
        address token,
        uint256 amount,
        uint40 expiresAt
    );
    event SessionToppedUp(bytes32 indexed sessionId, address indexed from, uint256 amount);
    event VoucherRedeemed(
        bytes32 indexed sessionId,
        address indexed payee,
        uint256 cumulativeAmount,
        uint256 paid,
        uint256 fee
    );
    event SessionCloseRequested(bytes32 indexed sessionId, uint40 closesAt);
    event SessionClosed(bytes32 indexed sessionId, uint256 refunded);
    event CloseDelaySet(uint32 closeDelay);

    error TokenNotAllowed(address token);
    error InvalidSigner();
    error InvalidAmount();
    error InvalidExpiry();
    error SessionNotFound(bytes32 sessionId);
    error NotSessionOwner(bytes32 sessionId, address caller);
    error SessionClosing(bytes32 sessionId);
    error RedemptionWindowOver(bytes32 sessionId);
    error InvalidVoucherSignature();
    error NothingToRedeem();
    error StillRedeemable(bytes32 sessionId, uint256 until);
    error InvalidCloseDelay(uint32 closeDelay);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        IPlanFactory planFactory_,
        FeeCollector feeCollector_,
        uint32 closeDelay_
    ) external initializer {
        __AccessControl_init();
        __EIP712_init("Mona Visa SessionVault", "1");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        planFactory = planFactory_;
        feeCollector = feeCollector_;
        _setCloseDelay(closeDelay_);
    }

    function setCloseDelay(uint32 closeDelay_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setCloseDelay(closeDelay_);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Opens a session funded from the caller. `token` must be allowlisted in PlanFactory.
    function openSession(address signer, address token, uint96 amount, uint40 expiresAt)
        external
        nonReentrant
        returns (bytes32 sessionId)
    {
        if (!planFactory.allowedToken(token)) revert TokenNotAllowed(token);
        if (signer == address(0)) revert InvalidSigner();
        if (amount == 0) revert InvalidAmount();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();

        sessionId = keccak256(abi.encode(msg.sender, ++sessionCount[msg.sender]));
        _sessions[sessionId] = Session({
            owner: msg.sender,
            balance: amount,
            signer: signer,
            expiresAt: expiresAt,
            closesAt: 0,
            token: token
        });
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit SessionOpened(sessionId, msg.sender, signer, token, amount, expiresAt);
    }

    /// @notice Adds funds to an open session. Anyone may top up.
    function topUp(bytes32 sessionId, uint96 amount) external nonReentrant {
        Session storage s = _get(sessionId);
        if (amount == 0) revert InvalidAmount();
        if (s.closesAt != 0) revert SessionClosing(sessionId);
        s.balance += amount;
        IERC20(s.token).safeTransferFrom(msg.sender, address(this), amount);
        emit SessionToppedUp(sessionId, msg.sender, amount);
    }

    /// @notice Starts the close delay. No new vouchers should be accepted after this.
    function requestClose(bytes32 sessionId) external {
        Session storage s = _owned(sessionId);
        if (s.closesAt != 0) revert SessionClosing(sessionId);
        uint40 closesAt = uint40(block.timestamp) + closeDelay;
        s.closesAt = closesAt;
        emit SessionCloseRequested(sessionId, closesAt);
    }

    /// @notice Returns the unspent balance once the redemption window is over.
    function withdraw(bytes32 sessionId) external nonReentrant returns (uint256 refunded) {
        Session storage s = _owned(sessionId);
        uint256 deadline = redemptionDeadline(sessionId);
        if (block.timestamp < deadline) revert StillRedeemable(sessionId, deadline);
        refunded = s.balance;
        s.balance = 0;
        if (refunded > 0) IERC20(s.token).safeTransfer(s.owner, refunded);
        emit SessionClosed(sessionId, refunded);
    }

    // ------------------------------------------------------------------ payees

    /// @notice Pays `payee` everything its voucher covers beyond what was already redeemed, up to
    ///         the session balance. Callable by anyone (payee, facilitator, keeper).
    function redeem(
        bytes32 sessionId,
        address payee,
        uint256 cumulativeAmount,
        bytes calldata signature
    ) external nonReentrant returns (uint256 paid) {
        return _redeem(sessionId, payee, cumulativeAmount, signature);
    }

    struct Redemption {
        bytes32 sessionId;
        address payee;
        uint256 cumulativeAmount;
        bytes signature;
    }

    function redeemMany(Redemption[] calldata redemptions)
        external
        nonReentrant
        returns (uint256[] memory paid)
    {
        paid = new uint256[](redemptions.length);
        for (uint256 i; i < redemptions.length; ++i) {
            Redemption calldata r = redemptions[i];
            paid[i] = _redeem(r.sessionId, r.payee, r.cumulativeAmount, r.signature);
        }
    }

    // ------------------------------------------------------------------ views

    function getSession(bytes32 sessionId) external view returns (Session memory) {
        return _sessions[sessionId];
    }

    /// @notice After this time vouchers can no longer be redeemed and the owner may withdraw.
    function redemptionDeadline(bytes32 sessionId) public view returns (uint256) {
        Session storage s = _sessions[sessionId];
        uint256 afterExpiry = uint256(s.expiresAt) + closeDelay;
        if (s.closesAt == 0) return afterExpiry;
        return s.closesAt < afterExpiry ? s.closesAt : afterExpiry;
    }

    function voucherDigest(bytes32 sessionId, address payee, uint256 cumulativeAmount)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(VOUCHER_TYPEHASH, sessionId, payee, cumulativeAmount))
        );
    }

    // ------------------------------------------------------------------ internal

    function _redeem(
        bytes32 sessionId,
        address payee,
        uint256 cumulativeAmount,
        bytes calldata signature
    ) private returns (uint256 paid) {
        Session storage s = _get(sessionId);
        if (block.timestamp >= redemptionDeadline(sessionId)) {
            revert RedemptionWindowOver(sessionId);
        }
        if (!SignatureChecker.isValidSignatureNow(
                s.signer, voucherDigest(sessionId, payee, cumulativeAmount), signature
            )) revert InvalidVoucherSignature();

        uint256 already = redeemed[sessionId][payee];
        if (cumulativeAmount <= already) revert NothingToRedeem();
        uint256 owed = cumulativeAmount - already;
        // A short balance pays what it can; the rest stays redeemable if the session is topped up.
        paid = owed < s.balance ? owed : s.balance;
        if (paid == 0) revert NothingToRedeem();

        s.balance -= paid.toUint96();
        redeemed[sessionId][payee] = already + paid;

        uint256 fee = feeCollector.computeFee(paid, feeCollector.agentFeeBps());
        IERC20 token = IERC20(s.token);
        token.safeTransfer(payee, paid - fee);
        if (fee > 0) {
            token.safeTransfer(address(feeCollector), fee);
            feeCollector.notifyFee(address(token), fee);
        }
        emit VoucherRedeemed(sessionId, payee, cumulativeAmount, paid, fee);
    }

    function _get(bytes32 sessionId) private view returns (Session storage s) {
        s = _sessions[sessionId];
        if (s.owner == address(0)) revert SessionNotFound(sessionId);
    }

    function _owned(bytes32 sessionId) private view returns (Session storage s) {
        s = _get(sessionId);
        if (s.owner != msg.sender) revert NotSessionOwner(sessionId, msg.sender);
    }

    function _setCloseDelay(uint32 closeDelay_) private {
        if (closeDelay_ < MIN_CLOSE_DELAY || closeDelay_ > MAX_CLOSE_DELAY) {
            revert InvalidCloseDelay(closeDelay_);
        }
        closeDelay = closeDelay_;
        emit CloseDelaySet(closeDelay_);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
