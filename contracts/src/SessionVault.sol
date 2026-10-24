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

    enum EscrowStatus {
        None,
        Reserved,
        Committed,
        Settled,
        Refunded
    }

    /// @dev Four storage slots for escrow state.
    struct Escrow {
        bytes32 sessionId;
        address provider;
        uint96 amount;
        uint40 deadline;
        EscrowStatus status;
        bytes32 commitment;
    }

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 sessionId,address payee,uint256 cumulativeAmount)");
    bytes32 public constant RESERVE_TYPEHASH = keccak256(
        "Reserve(bytes32 sessionId,address provider,uint96 amount,uint40 deadline,bytes32 nonce)"
    );
    bytes32 public constant CONFIRM_TYPEHASH = keccak256("Confirm(bytes32 escrowId)");

    uint32 public constant MIN_CLOSE_DELAY = 5 minutes;
    uint32 public constant MAX_CLOSE_DELAY = 7 days;
    /// @notice Longest a session may stay open, so funds are never locked indefinitely.
    uint32 public constant MAX_SESSION_DURATION = 365 days;

    IPlanFactory public planFactory;
    FeeCollector public feeCollector;
    /// @notice Time payees get to redeem vouchers after a session expires or its owner asks to close.
    uint32 public closeDelay;

    mapping(bytes32 sessionId => Session) private _sessions;
    /// @notice Cumulative amount already paid out to each payee of a session.
    mapping(bytes32 sessionId => mapping(address payee => uint256)) public redeemed;
    mapping(address owner => uint256) public sessionCount;

    mapping(bytes32 escrowId => Escrow) private _escrows;
    mapping(bytes32 sessionId => mapping(bytes32 nonce => bool)) public usedNonces;
    mapping(address issuer => mapping(bytes32 mandateHash => bool)) public isMandateRevoked;

    event SessionOpened(
        bytes32 indexed sessionId,
        address indexed owner,
        address indexed signer,
        address token,
        uint256 amount,
        uint40 expiresAt
    );
    event SessionToppedUp(bytes32 indexed sessionId, address indexed from, uint256 amount);
    event SessionExtended(bytes32 indexed sessionId, uint40 expiresAt);
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

    event EscrowReserved(
        bytes32 indexed escrowId,
        bytes32 indexed sessionId,
        address indexed provider,
        uint96 amount,
        uint40 deadline
    );
    event EscrowCommitted(bytes32 indexed escrowId, bytes32 commitment);
    event EscrowSettled(bytes32 indexed escrowId, uint256 amount, uint256 fee);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 amount);
    event MandateRevoked(address indexed issuer, bytes32 indexed mandateHash);

    error TokenNotAllowed(address token);
    error InvalidSigner();
    error InvalidAmount();
    error InvalidExpiry();
    error SessionNotFound(bytes32 sessionId);
    error NotSessionOwner(bytes32 sessionId, address caller);
    error SessionClosing(bytes32 sessionId);
    error SessionExpired(bytes32 sessionId);
    error RedemptionWindowOver(bytes32 sessionId);
    error InvalidVoucherSignature();
    error NothingToRedeem();
    error StillRedeemable(bytes32 sessionId, uint256 until);
    error InvalidCloseDelay(uint32 closeDelay);

    error EscrowNotFound(bytes32 escrowId);
    error EscrowAlreadyExists(bytes32 escrowId);
    error EscrowNotActive(bytes32 escrowId);
    error EscrowDeadlinePassed(bytes32 escrowId);
    error EscrowDeadlineNotPassed(bytes32 escrowId);
    error NotEscrowProvider(bytes32 escrowId, address caller);
    error InvalidCommitment();
    error NonceAlreadyUsed(bytes32 sessionId, bytes32 nonce);
    error InvalidReservationSignature();
    error InvalidConfirmationSignature();
    error InsufficientSessionBalance(bytes32 sessionId, uint256 requested, uint256 balance);

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
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_SESSION_DURATION) {
            revert InvalidExpiry();
        }

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

    /// @notice Adds funds to an open, unexpired session. Anyone may top up.
    function topUp(bytes32 sessionId, uint96 amount) external nonReentrant {
        Session storage s = _get(sessionId);
        if (amount == 0) revert InvalidAmount();
        _requireOpen(sessionId, s);
        s.balance += amount;
        IERC20(s.token).safeTransferFrom(msg.sender, address(this), amount);
        emit SessionToppedUp(sessionId, msg.sender, amount);
    }

    /// @notice Moves the expiry of an open session later. Never shortens it, so accepted vouchers
    ///         keep at least the redemption window they were given.
    function extendSession(bytes32 sessionId, uint40 expiresAt) external {
        Session storage s = _owned(sessionId);
        _requireOpen(sessionId, s);
        if (expiresAt <= s.expiresAt || expiresAt > block.timestamp + MAX_SESSION_DURATION) {
            revert InvalidExpiry();
        }
        s.expiresAt = expiresAt;
        emit SessionExtended(sessionId, expiresAt);
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

    // ------------------------------------------------------------------ mandate revocation

    /// @notice Revokes a mandate on-chain by hash.
    function revokeMandate(bytes32 mandateHash) external {
        isMandateRevoked[msg.sender][mandateHash] = true;
        emit MandateRevoked(msg.sender, mandateHash);
    }

    // ------------------------------------------------------------------ escrow (Verify-Then-Settle)

    /// @notice Reserves an amount from an open session for escrow. Callable directly by session owner/signer,
    ///         or by any relayer with a valid signature from session signer.
    function reserve(
        bytes32 sessionId,
        address provider,
        uint96 amount,
        uint40 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 escrowId) {
        if (provider == address(0)) revert InvalidSigner();
        if (amount == 0) revert InvalidAmount();
        Session storage s = _get(sessionId);
        _requireOpen(sessionId, s);
        if (deadline <= block.timestamp || deadline > s.expiresAt) revert InvalidExpiry();
        if (usedNonces[sessionId][nonce]) revert NonceAlreadyUsed(sessionId, nonce);
        if (amount > s.balance) revert InsufficientSessionBalance(sessionId, amount, s.balance);

        if (msg.sender != s.signer && msg.sender != s.owner) {
            bytes32 digest = reserveDigest(sessionId, provider, amount, deadline, nonce);
            if (!SignatureChecker.isValidSignatureNow(s.signer, digest, signature)) {
                revert InvalidReservationSignature();
            }
        }

        usedNonces[sessionId][nonce] = true;
        s.balance -= amount;

        escrowId = keccak256(abi.encode(sessionId, provider, nonce));
        if (_escrows[escrowId].status != EscrowStatus.None) revert EscrowAlreadyExists(escrowId);

        _escrows[escrowId] = Escrow({
            sessionId: sessionId,
            provider: provider,
            amount: amount,
            deadline: deadline,
            status: EscrowStatus.Reserved,
            commitment: bytes32(0)
        });

        emit EscrowReserved(escrowId, sessionId, provider, amount, deadline);
    }

    /// @notice Provider commits hash of delivery payload (C = SHA-256(canonical(data))).
    function commit(bytes32 escrowId, bytes32 commitment) external {
        if (commitment == bytes32(0)) revert InvalidCommitment();
        Escrow storage e = _getEscrow(escrowId);
        if (msg.sender != e.provider) revert NotEscrowProvider(escrowId, msg.sender);
        if (e.status != EscrowStatus.Reserved) revert EscrowNotActive(escrowId);
        if (block.timestamp >= e.deadline) revert EscrowDeadlinePassed(escrowId);

        e.commitment = commitment;
        e.status = EscrowStatus.Committed;
        emit EscrowCommitted(escrowId, commitment);
    }

    /// @notice Recipient confirms delivery and pays the provider (minus protocol fee).
    ///         Callable directly by session owner/signer, or by anyone with signer's confirmation.
    function confirm(bytes32 escrowId, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 paid)
    {
        Escrow storage e = _getEscrow(escrowId);
        if (e.status != EscrowStatus.Reserved && e.status != EscrowStatus.Committed) {
            revert EscrowNotActive(escrowId);
        }
        if (block.timestamp >= e.deadline) revert EscrowDeadlinePassed(escrowId);

        Session storage s = _get(e.sessionId);
        if (msg.sender != s.signer && msg.sender != s.owner) {
            bytes32 digest = confirmDigest(escrowId);
            if (!SignatureChecker.isValidSignatureNow(s.signer, digest, signature)) {
                revert InvalidConfirmationSignature();
            }
        }

        e.status = EscrowStatus.Settled;
        paid = e.amount;

        uint256 fee = feeCollector.computeFee(paid, feeCollector.agentFeeBps());
        IERC20 token = IERC20(s.token);
        token.safeTransfer(e.provider, paid - fee);
        if (fee > 0) {
            token.safeTransfer(address(feeCollector), fee);
            feeCollector.notifyFee(address(token), fee);
        }

        emit EscrowSettled(escrowId, paid, fee);
    }

    /// @notice Returns reserved funds to the session (or owner if closed) if deadline expired without confirmation.
    function refund(bytes32 escrowId) external nonReentrant returns (uint256 amount) {
        Escrow storage e = _getEscrow(escrowId);
        if (e.status != EscrowStatus.Reserved && e.status != EscrowStatus.Committed) {
            revert EscrowNotActive(escrowId);
        }
        if (block.timestamp < e.deadline) revert EscrowDeadlineNotPassed(escrowId);

        e.status = EscrowStatus.Refunded;
        amount = e.amount;

        Session storage s = _get(e.sessionId);
        if (block.timestamp < redemptionDeadline(e.sessionId)) {
            s.balance += uint96(amount);
        } else {
            IERC20(s.token).safeTransfer(s.owner, amount);
        }

        emit EscrowRefunded(escrowId, amount);
    }

    // ------------------------------------------------------------------ escrow views

    function getEscrow(bytes32 escrowId) external view returns (Escrow memory) {
        return _escrows[escrowId];
    }

    function reserveDigest(
        bytes32 sessionId,
        address provider,
        uint96 amount,
        uint40 deadline,
        bytes32 nonce
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(RESERVE_TYPEHASH, sessionId, provider, amount, deadline, nonce))
        );
    }

    function confirmDigest(bytes32 escrowId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CONFIRM_TYPEHASH, escrowId)));
    }

    function _getEscrow(bytes32 escrowId) private view returns (Escrow storage e) {
        e = _escrows[escrowId];
        if (e.status == EscrowStatus.None) revert EscrowNotFound(escrowId);
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

    /// @dev Open means no close was requested and the session has not expired.
    function _requireOpen(bytes32 sessionId, Session storage s) private view {
        if (s.closesAt != 0) revert SessionClosing(sessionId);
        if (block.timestamp >= s.expiresAt) revert SessionExpired(sessionId);
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
