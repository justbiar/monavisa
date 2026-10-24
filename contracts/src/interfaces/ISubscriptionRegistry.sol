// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISubscriptionRegistry {
    /// @dev Values match `SubscriptionStatus` in packages/core/src/entitlement.ts.
    enum Status {
        None,
        Active,
        PastDue,
        Canceled,
        Expired
    }

    /// @dev One storage slot. The subscriber is the owner of the (soulbound) token.
    struct Subscription {
        uint64 planId;
        uint40 currentPeriodStart;
        uint40 currentPeriodEnd;
        Status status;
    }

    event SubscriptionActivated(
        uint256 indexed subId,
        address indexed subscriber,
        uint256 indexed planId,
        uint40 periodStart,
        uint40 periodEnd
    );
    event SubscriptionRenewed(uint256 indexed subId, uint40 periodStart, uint40 periodEnd);
    event SubscriptionPastDue(uint256 indexed subId);
    event SubscriptionCanceled(uint256 indexed subId);
    event SubscriptionExpired(uint256 indexed subId);

    error Soulbound();
    error AlreadySubscribed(address subscriber, uint256 planId, uint256 subId);
    error SubscriptionNotFound(uint256 subId);
    error NotSubscriber(uint256 subId, address caller);
    error InvalidStatus(uint256 subId, Status status);
    error NotExpirable(uint256 subId);

    function activate(address subscriber, uint256 planId, uint40 periodStart, uint40 periodEnd)
        external
        returns (uint256 subId);

    function renew(uint256 subId, uint40 periodStart, uint40 periodEnd) external;

    function markPastDue(uint256 subId) external;

    function expire(uint256 subId) external;

    function getSubscription(uint256 subId) external view returns (Subscription memory);

    function subscriberOf(uint256 subId) external view returns (address);

    function subscriptionOf(address subscriber, uint256 planId) external view returns (uint256);

    function isEntitled(address subscriber, uint256 planId) external view returns (bool);

    function isExpirable(uint256 subId) external view returns (bool);
}
