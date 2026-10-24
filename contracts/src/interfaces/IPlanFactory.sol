// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPlanFactory {
    /// @dev Packed into three storage slots. Pricing never changes after creation:
    ///      a new price is a new plan, so existing subscribers keep the terms they signed up for.
    struct Plan {
        address merchant;
        uint96 price;
        address token;
        uint32 period;
        uint32 trialPeriod;
        uint32 gracePeriod;
        address treasury;
        bool active;
    }

    event TokenAllowed(address indexed token, bool allowed);
    event PlanCreated(
        uint256 indexed planId,
        address indexed merchant,
        address indexed token,
        uint96 price,
        uint32 period,
        uint32 trialPeriod,
        uint32 gracePeriod,
        address treasury
    );
    event PlanActiveSet(uint256 indexed planId, bool active);
    event PlanTreasurySet(uint256 indexed planId, address treasury);

    error TokenNotAllowed(address token);
    error InvalidPrice();
    error InvalidPeriod();
    error InvalidTreasury();
    error PlanNotFound(uint256 planId);
    error NotPlanMerchant(uint256 planId, address caller);

    function getPlan(uint256 planId) external view returns (Plan memory);
}
