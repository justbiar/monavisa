// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    ERC721Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPlanFactory} from "./interfaces/IPlanFactory.sol";
import {ISubscriptionRegistry} from "./interfaces/ISubscriptionRegistry.sol";

/// @title SubscriptionRegistry
/// @notice Each subscription is a soulbound ERC-721 held by the subscriber.
///         Entitlement: E(c, f, t) = 1[ Sub(c) and t0 <= t < t0 + period ], plus grace when past due.
/// @dev Only the AutopayModule (MODULE_ROLE) moves money-related state. Subscribers cancel here
///      directly, and anyone may expire a subscription whose access has ended.
contract SubscriptionRegistry is
    ISubscriptionRegistry,
    Initializable,
    ERC721Upgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MODULE_ROLE = keccak256("MODULE_ROLE");

    IPlanFactory public planFactory;
    uint256 public subscriptionCount;
    mapping(uint256 subId => Subscription) private _subs;
    mapping(address subscriber => mapping(uint256 planId => uint256 subId)) private _current;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, IPlanFactory planFactory_) external initializer {
        __ERC721_init("MonCart Subscription", "MCSUB");
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        planFactory = planFactory_;
    }

    // ------------------------------------------------------------------ module

    function activate(
        address subscriber,
        uint256 planId,
        uint40 periodStart,
        uint40 periodEnd,
        bool inTrial
    ) external onlyRole(MODULE_ROLE) returns (uint256 subId) {
        uint256 existing = _current[subscriber][planId];
        if (existing != 0) {
            if (!_settleIfOver(existing)) revert AlreadySubscribed(subscriber, planId, existing);
        }

        subId = ++subscriptionCount;
        _subs[subId] = Subscription({
            planId: SafeCast.toUint64(planId),
            pendingPlanId: 0,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            status: Status.Active,
            inTrial: inTrial
        });
        _current[subscriber][planId] = subId;
        _mint(subscriber, subId);

        emit SubscriptionActivated(subId, subscriber, planId, periodStart, periodEnd);
    }

    function renew(uint256 subId, uint40 periodStart, uint40 periodEnd)
        external
        onlyRole(MODULE_ROLE)
    {
        Subscription storage sub = _get(subId);
        if (sub.status != Status.Active && sub.status != Status.PastDue) {
            revert InvalidStatus(subId, sub.status);
        }
        sub.currentPeriodStart = periodStart;
        sub.currentPeriodEnd = periodEnd;
        sub.status = Status.Active;
        sub.inTrial = false;
        emit SubscriptionRenewed(subId, periodStart, periodEnd);
    }

    /// @notice Moves a subscription to another plan and starts a new paid period on it.
    function switchPlan(uint256 subId, uint256 toPlanId, uint40 periodStart, uint40 periodEnd)
        external
        onlyRole(MODULE_ROLE)
    {
        Subscription storage sub = _get(subId);
        if (sub.status != Status.Active && sub.status != Status.PastDue) {
            revert InvalidStatus(subId, sub.status);
        }
        address subscriber = _ownerOf(subId);
        uint256 existing = _current[subscriber][toPlanId];
        if (existing != 0 && !_settleIfOver(existing)) {
            revert AlreadySubscribed(subscriber, toPlanId, existing);
        }

        uint256 fromPlanId = sub.planId;
        delete _current[subscriber][fromPlanId];
        _current[subscriber][toPlanId] = subId;

        sub.planId = SafeCast.toUint64(toPlanId);
        sub.pendingPlanId = 0;
        sub.currentPeriodStart = periodStart;
        sub.currentPeriodEnd = periodEnd;
        sub.status = Status.Active;
        sub.inTrial = false;
        emit SubscriptionPlanChanged(subId, fromPlanId, toPlanId, periodStart, periodEnd);
    }

    /// @notice Records a plan change for the next renewal. `toPlanId` 0 clears it.
    function schedulePlanChange(uint256 subId, uint256 toPlanId) external onlyRole(MODULE_ROLE) {
        Subscription storage sub = _get(subId);
        if (sub.status != Status.Active) revert InvalidStatus(subId, sub.status);
        sub.pendingPlanId = SafeCast.toUint64(toPlanId);
        emit SubscriptionPlanChangeScheduled(subId, toPlanId);
    }

    function markPastDue(uint256 subId) external onlyRole(MODULE_ROLE) {
        Subscription storage sub = _get(subId);
        if (sub.status != Status.Active) revert InvalidStatus(subId, sub.status);
        sub.status = Status.PastDue;
        emit SubscriptionPastDue(subId);
    }

    // ------------------------------------------------------------------ public

    /// @notice Stops renewals. Access continues until the paid period ends.
    function cancel(uint256 subId) external {
        Subscription storage sub = _get(subId);
        if (_ownerOf(subId) != msg.sender) revert NotSubscriber(subId, msg.sender);
        if (sub.status != Status.Active && sub.status != Status.PastDue) {
            revert InvalidStatus(subId, sub.status);
        }
        sub.status = Status.Canceled;
        emit SubscriptionCanceled(subId);
    }

    /// @notice Marks a subscription whose access has ended as expired. Callable by anyone.
    function expire(uint256 subId) external {
        if (!_settleIfOver(subId)) revert NotExpirable(subId);
    }

    // ------------------------------------------------------------------ views

    function getSubscription(uint256 subId) external view returns (Subscription memory) {
        return _get(subId);
    }

    function subscriberOf(uint256 subId) external view returns (address) {
        return _ownerOf(subId);
    }

    function subscriptionOf(address subscriber, uint256 planId) external view returns (uint256) {
        return _current[subscriber][planId];
    }

    function isEntitled(address subscriber, uint256 planId) external view returns (bool) {
        uint256 subId = _current[subscriber][planId];
        return subId != 0 && _hasAccess(_subs[subId]);
    }

    function isActive(uint256 subId) external view returns (bool) {
        return _hasAccess(_subs[subId]);
    }

    function isExpirable(uint256 subId) public view returns (bool) {
        Subscription storage sub = _subs[subId];
        return sub.status != Status.None && sub.status != Status.Expired && !_hasAccess(sub);
    }

    /// @notice Whether `subscriber` could move onto `toPlanId` without clashing with a live subscription.
    function canSwitch(address subscriber, uint256 toPlanId) external view returns (bool) {
        uint256 existing = _current[subscriber][toPlanId];
        return existing == 0 || _subs[existing].status == Status.Expired || isExpirable(existing);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ internal

    function _hasAccess(Subscription storage sub) private view returns (bool) {
        Status status = sub.status;
        uint256 nowTs = block.timestamp;
        if (nowTs < sub.currentPeriodStart) return false;
        if (status == Status.Active || status == Status.Canceled) {
            return nowTs < sub.currentPeriodEnd;
        }
        if (status == Status.PastDue) {
            uint32 grace = planFactory.getPlan(sub.planId).gracePeriod;
            return nowTs < uint256(sub.currentPeriodEnd) + grace;
        }
        return false;
    }

    /// @dev Expires `subId` if its access has ended. Returns whether it is now expired.
    function _settleIfOver(uint256 subId) private returns (bool) {
        Subscription storage sub = _subs[subId];
        if (sub.status == Status.Expired) return true;
        if (!isExpirable(subId)) return false;
        sub.status = Status.Expired;
        emit SubscriptionExpired(subId);
        return true;
    }

    function _get(uint256 subId) private view returns (Subscription storage sub) {
        sub = _subs[subId];
        if (sub.status == Status.None) revert SubscriptionNotFound(subId);
    }

    /// @dev Soulbound: mint only, no transfers.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address from)
    {
        from = _ownerOf(tokenId);
        if (from != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
