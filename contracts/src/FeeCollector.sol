// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";

/// @title FeeCollector
/// @notice Holds protocol fees and routes them to the treasury. F = rho * P, rho in basis points.
/// @dev Withdrawal is permissionless and always goes to `treasury`, so routing is deterministic.
contract FeeCollector is IFeeCollector, Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant FEE_SOURCE_ROLE = keccak256("FEE_SOURCE_ROLE");

    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Hard ceiling on any fee rate (10%), independent of what governance sets.
    uint16 public constant MAX_FEE_BPS = 1000;

    address public treasury;
    uint16 public subscriptionFeeBps;
    uint16 public agentFeeBps;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address treasury_,
        uint16 subscriptionFeeBps_,
        uint16 agentFeeBps_
    ) external initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_MANAGER_ROLE, admin);
        _setTreasury(treasury_);
        _setFeeRates(subscriptionFeeBps_, agentFeeBps_);
    }

    function setFeeRates(uint16 subscriptionFeeBps_, uint16 agentFeeBps_)
        external
        onlyRole(FEE_MANAGER_ROLE)
    {
        _setFeeRates(subscriptionFeeBps_, agentFeeBps_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTreasury(treasury_);
    }

    /// @notice Called by a fee source after it has transferred `amount` of `token` here.
    function notifyFee(address token, uint256 amount) external onlyRole(FEE_SOURCE_ROLE) {
        emit FeeReceived(token, msg.sender, amount);
    }

    /// @notice Sends the full balance of `token` to the treasury. Callable by anyone.
    function withdraw(address token) external returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) return 0;
        address to = treasury;
        IERC20(token).safeTransfer(to, amount);
        emit FeesWithdrawn(token, to, amount);
    }

    /// @notice Protocol fee on `amount` at `feeBps`, rounded down.
    function computeFee(uint256 amount, uint16 feeBps) public pure returns (uint256) {
        return amount * feeBps / BPS_DENOMINATOR;
    }

    function _setFeeRates(uint16 subscriptionFeeBps_, uint16 agentFeeBps_) private {
        if (subscriptionFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh(subscriptionFeeBps_, MAX_FEE_BPS);
        if (agentFeeBps_ > MAX_FEE_BPS) revert FeeTooHigh(agentFeeBps_, MAX_FEE_BPS);
        subscriptionFeeBps = subscriptionFeeBps_;
        agentFeeBps = agentFeeBps_;
        emit FeeRatesSet(subscriptionFeeBps_, agentFeeBps_);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert InvalidTreasury();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
