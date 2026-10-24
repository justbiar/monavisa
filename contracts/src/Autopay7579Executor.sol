// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC7579Module, IERC7579Account} from "./interfaces/IERC7579.sol";

/// @title Autopay7579Executor
/// @notice ERC-7579 Executor Module for automated recurring and agent payments on Monad.
/// @dev Allows smart accounts (such as ZeroDev, Biconomy, Safe7579) to delegate recurring
///      token transfers to Mona Visa keepers within user-defined spend bounds.
contract Autopay7579Executor is IERC7579Module {
    uint256 public constant MODULE_TYPE_EXECUTOR = 2;

    struct AccountConfig {
        bool initialized;
        address allowedToken;
        uint256 maxPerCall;
        uint256 maxTotal;
        uint256 totalSpent;
    }

    mapping(address => AccountConfig) public accountConfigs;

    event AutoPayConfigured(address indexed account, address token, uint256 maxPerCall, uint256 maxTotal);
    event AutoPayExecuted(address indexed account, address indexed recipient, uint256 amount);
    event AutoPayUninstalled(address indexed account);

    error NotInitialized();
    error AlreadyInitialized();
    error ExceedsMaxPerCall(uint256 amount, uint256 maxPerCall);
    error ExceedsMaxTotal(uint256 newTotal, uint256 maxTotal);
    error ExecutionFailed();

    /// @inheritdoc IERC7579Module
    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    /// @inheritdoc IERC7579Module
    function isInitialized(address smartAccount) external view override returns (bool) {
        return accountConfigs[smartAccount].initialized;
    }

    /// @inheritdoc IERC7579Module
    function onInstall(bytes calldata data) external override {
        if (accountConfigs[msg.sender].initialized) revert AlreadyInitialized();

        (address token, uint256 maxPerCall, uint256 maxTotal) = abi.decode(data, (address, uint256, uint256));
        accountConfigs[msg.sender] = AccountConfig({
            initialized: true,
            allowedToken: token,
            maxPerCall: maxPerCall,
            maxTotal: maxTotal,
            totalSpent: 0
        });

        emit AutoPayConfigured(msg.sender, token, maxPerCall, maxTotal);
    }

    /// @inheritdoc IERC7579Module
    function onUninstall(bytes calldata) external override {
        if (!accountConfigs[msg.sender].initialized) revert NotInitialized();
        delete accountConfigs[msg.sender];
        emit AutoPayUninstalled(msg.sender);
    }

    /// @notice Executes an automated payment from the smart account.
    /// @param smartAccount The ERC-7579 smart account to pull funds from.
    /// @param recipient The address receiving the payment.
    /// @param amount The token amount to transfer.
    function executeAutoPay(
        address smartAccount,
        address recipient,
        uint256 amount
    ) external returns (bytes[] memory returnData) {
        AccountConfig storage cfg = accountConfigs[smartAccount];
        if (!cfg.initialized) revert NotInitialized();
        if (amount > cfg.maxPerCall) revert ExceedsMaxPerCall(amount, cfg.maxPerCall);
        if (cfg.totalSpent + amount > cfg.maxTotal) {
            revert ExceedsMaxTotal(cfg.totalSpent + amount, cfg.maxTotal);
        }

        cfg.totalSpent += amount;

        // Encode ERC20 transfer(recipient, amount)
        bytes memory callData = abi.encodeCall(IERC20.transfer, (recipient, amount));

        // Format single execution callData: target (20 bytes) + value (32 bytes) + callData
        bytes memory executionCalldata = abi.encodePacked(
            cfg.allowedToken,
            uint256(0),
            callData
        );

        // Mode 0 = single default execution
        returnData = IERC7579Account(smartAccount).executeFromExecutor(
            bytes32(0),
            executionCalldata
        );

        emit AutoPayExecuted(smartAccount, recipient, amount);
    }
}
