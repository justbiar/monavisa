// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IPlanFactory} from "./interfaces/IPlanFactory.sol";

/// @title PlanFactory
/// @notice Merchants register subscription plans here. Plan ids start at 1.
contract PlanFactory is IPlanFactory, Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant TOKEN_MANAGER_ROLE = keccak256("TOKEN_MANAGER_ROLE");

    uint32 public constant MIN_PERIOD = 1 hours;
    uint32 public constant MAX_PERIOD = 366 days;
    uint32 public constant MAX_TRIAL = 90 days;
    uint32 public constant MAX_GRACE = 30 days;

    mapping(address token => bool) public allowedToken;
    mapping(uint256 planId => Plan) private _plans;
    uint256 public planCount;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address[] calldata tokens) external initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(TOKEN_MANAGER_ROLE, admin);
        for (uint256 i; i < tokens.length; ++i) {
            _setTokenAllowed(tokens[i], true);
        }
    }

    function setTokenAllowed(address token, bool allowed) external onlyRole(TOKEN_MANAGER_ROLE) {
        _setTokenAllowed(token, allowed);
    }

    /// @notice Registers a plan owned by the caller. `treasury` receives subscription revenue.
    function createPlan(
        address token,
        uint96 price,
        uint32 period,
        uint32 trialPeriod,
        uint32 gracePeriod,
        address treasury
    ) external returns (uint256 planId) {
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (price == 0) revert InvalidPrice();
        if (period < MIN_PERIOD || period > MAX_PERIOD) revert InvalidPeriod();
        if (trialPeriod > MAX_TRIAL || gracePeriod > MAX_GRACE) revert InvalidPeriod();
        if (treasury == address(0)) revert InvalidTreasury();

        planId = ++planCount;
        _plans[planId] = Plan({
            merchant: msg.sender,
            price: price,
            token: token,
            period: period,
            trialPeriod: trialPeriod,
            gracePeriod: gracePeriod,
            treasury: treasury,
            active: true
        });

        emit PlanCreated(
            planId, msg.sender, token, price, period, trialPeriod, gracePeriod, treasury
        );
    }

    /// @notice Inactive plans accept no new subscribers. Existing subscriptions keep renewing.
    function setPlanActive(uint256 planId, bool active) external {
        _onlyMerchant(planId).active = active;
        emit PlanActiveSet(planId, active);
    }

    function setPlanTreasury(uint256 planId, address treasury) external {
        if (treasury == address(0)) revert InvalidTreasury();
        _onlyMerchant(planId).treasury = treasury;
        emit PlanTreasurySet(planId, treasury);
    }

    function getPlan(uint256 planId) external view returns (Plan memory) {
        Plan memory plan = _plans[planId];
        if (plan.merchant == address(0)) revert PlanNotFound(planId);
        return plan;
    }

    function _onlyMerchant(uint256 planId) private view returns (Plan storage plan) {
        plan = _plans[planId];
        if (plan.merchant == address(0)) revert PlanNotFound(planId);
        if (plan.merchant != msg.sender) revert NotPlanMerchant(planId, msg.sender);
    }

    function _setTokenAllowed(address token, bool allowed) private {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
