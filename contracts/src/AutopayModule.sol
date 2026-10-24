// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FeeCollector} from "./FeeCollector.sol";
import {IAllowanceTransfer} from "./interfaces/IAllowanceTransfer.sol";
import {IPlanFactory} from "./interfaces/IPlanFactory.sol";
import {ISubscriptionRegistry} from "./interfaces/ISubscriptionRegistry.sol";

/// @title AutopayModule
/// @notice Charges subscriptions through Permit2 allowances. The subscriber signs (or approves)
///         one capped, expiring Permit2 allowance for this module; every renewal pulls P + F.
/// @dev Renewal is permissionless: the keeper is just a caller, and the module only ever charges
///      what is due, when it is due. Funds pass through in a single call and never rest here.
contract AutopayModule is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    enum RenewalResult {
        NotDue,
        Renewed,
        PastDue,
        Expired,
        Skipped
    }

    IAllowanceTransfer public permit2;
    IPlanFactory public planFactory;
    ISubscriptionRegistry public registry;
    FeeCollector public feeCollector;

    event Charged(
        uint256 indexed subId,
        address indexed payer,
        address indexed treasury,
        address token,
        uint256 price,
        uint256 fee
    );
    event RenewalFailed(uint256 indexed subId, bytes reason);

    error PlanInactive(uint256 planId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        IAllowanceTransfer permit2_,
        IPlanFactory planFactory_,
        ISubscriptionRegistry registry_,
        FeeCollector feeCollector_
    ) external initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        permit2 = permit2_;
        planFactory = planFactory_;
        registry = registry_;
        feeCollector = feeCollector_;
    }

    // ------------------------------------------------------------------ subscribe

    /// @notice Subscribes the caller using an existing Permit2 allowance for this module.
    function subscribe(uint256 planId) external nonReentrant returns (uint256 subId) {
        return _subscribe(msg.sender, planId);
    }

    /// @notice Sets the caller's Permit2 allowance from a signature, then subscribes.
    function subscribeWithPermit(
        uint256 planId,
        IAllowanceTransfer.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 subId) {
        permit2.permit(msg.sender, permitSingle, signature);
        return _subscribe(msg.sender, planId);
    }

    // ------------------------------------------------------------------ renew

    /// @notice Processes due subscriptions. Safe to call for any id at any time.
    function renewMany(uint256[] calldata subIds)
        external
        nonReentrant
        returns (RenewalResult[] memory results)
    {
        results = new RenewalResult[](subIds.length);
        for (uint256 i; i < subIds.length; ++i) {
            results[i] = _renew(subIds[i]);
        }
    }

    function renew(uint256 subId) external nonReentrant returns (RenewalResult) {
        return _renew(subId);
    }

    /// @notice Total a renewal of `planId` will pull: price plus protocol fee.
    function chargeAmount(uint256 planId) external view returns (uint256 total) {
        uint256 price = planFactory.getPlan(planId).price;
        return price + feeCollector.computeFee(price, feeCollector.subscriptionFeeBps());
    }

    // ------------------------------------------------------------------ internal

    function _subscribe(address subscriber, uint256 planId) private returns (uint256 subId) {
        IPlanFactory.Plan memory plan = planFactory.getPlan(planId);
        if (!plan.active) revert PlanInactive(planId);

        uint40 start = uint40(block.timestamp);
        if (plan.trialPeriod > 0) {
            return registry.activate(subscriber, planId, start, start + plan.trialPeriod);
        }

        subId = registry.activate(subscriber, planId, start, start + plan.period);
        _charge(subId, subscriber, plan);
    }

    function _renew(uint256 subId) private returns (RenewalResult) {
        ISubscriptionRegistry.Subscription memory sub = registry.getSubscription(subId);
        ISubscriptionRegistry.Status status = sub.status;

        if (
            status != ISubscriptionRegistry.Status.Active
                && status != ISubscriptionRegistry.Status.PastDue
        ) {
            if (registry.isExpirable(subId)) {
                registry.expire(subId);
                return RenewalResult.Expired;
            }
            return RenewalResult.Skipped;
        }
        if (block.timestamp < sub.currentPeriodEnd) return RenewalResult.NotDue;

        IPlanFactory.Plan memory plan = planFactory.getPlan(sub.planId);
        if (block.timestamp >= uint256(sub.currentPeriodEnd) + plan.gracePeriod) {
            registry.expire(subId);
            return RenewalResult.Expired;
        }

        address subscriber = registry.subscriberOf(subId);
        (uint256 price, uint256 fee) = _amounts(plan);
        try permit2.transferFrom(subscriber, address(this), (price + fee).toUint160(), plan.token) {
            _distribute(subId, subscriber, plan, price, fee);
            // Periods chain from the previous end, so late payment inside grace does not shift billing dates.
            uint40 nextStart = sub.currentPeriodEnd;
            registry.renew(subId, nextStart, nextStart + plan.period);
            return RenewalResult.Renewed;
        } catch (bytes memory reason) {
            if (status == ISubscriptionRegistry.Status.Active) registry.markPastDue(subId);
            emit RenewalFailed(subId, reason);
            return RenewalResult.PastDue;
        }
    }

    function _charge(uint256 subId, address subscriber, IPlanFactory.Plan memory plan) private {
        (uint256 price, uint256 fee) = _amounts(plan);
        permit2.transferFrom(subscriber, address(this), (price + fee).toUint160(), plan.token);
        _distribute(subId, subscriber, plan, price, fee);
    }

    function _distribute(
        uint256 subId,
        address subscriber,
        IPlanFactory.Plan memory plan,
        uint256 price,
        uint256 fee
    ) private {
        IERC20 token = IERC20(plan.token);
        token.safeTransfer(plan.treasury, price);
        if (fee > 0) {
            token.safeTransfer(address(feeCollector), fee);
            feeCollector.notifyFee(plan.token, fee);
        }
        emit Charged(subId, subscriber, plan.treasury, plan.token, price, fee);
    }

    function _amounts(IPlanFactory.Plan memory plan)
        private
        view
        returns (uint256 price, uint256 fee)
    {
        price = plan.price;
        fee = feeCollector.computeFee(price, feeCollector.subscriptionFeeBps());
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
