// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ERC-7579 Module interface
interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
}

/// @notice ERC-7579 Smart Account execution interface
interface IERC7579Account {
    function executeFromExecutor(
        bytes32 mode,
        bytes calldata executionCalldata
    ) external payable returns (bytes[] memory returnData);
}
