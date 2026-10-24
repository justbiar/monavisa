// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Autopay7579Executor} from "../src/Autopay7579Executor.sol";
import {IERC7579Account} from "../src/interfaces/IERC7579.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract Mock7579Account is IERC7579Account {
    address public owner;
    mapping(address => bool) public isExecutor;

    constructor(address _owner) {
        owner = _owner;
    }

    function installExecutor(address executor, bytes calldata data) external {
        isExecutor[executor] = true;
        (bool ok,) = executor.call(abi.encodeWithSignature("onInstall(bytes)", data));
        require(ok, "install failed");
    }

    function executeFromExecutor(
        bytes32,
        bytes calldata executionCalldata
    ) external payable override returns (bytes[] memory returnData) {
        require(isExecutor[msg.sender], "not authorized executor");

        // Parse packed target (20 bytes) + value (32 bytes) + callData
        address target = address(bytes20(executionCalldata[0:20]));
        uint256 value = uint256(bytes32(executionCalldata[20:52]));
        bytes memory callData = executionCalldata[52:];

        (bool success, bytes memory result) = target.call{value: value}(callData);
        require(success, "execution failed");

        returnData = new bytes[](1);
        returnData[0] = result;
    }
}

contract Autopay7579Test is Test {
    Autopay7579Executor public executor;
    MockUSDC public usdc;
    Mock7579Account public account;
    address public alice = address(0xA11CE);
    address public merchant = address(0xDECA);

    function setUp() public {
        executor = new Autopay7579Executor();
        usdc = new MockUSDC();
        account = new Mock7579Account(alice);

        // Fund account with 1,000 USDC
        usdc.mint(address(account), 1_000 * 1e6);
    }

    function test_isModuleType() public view {
        assertTrue(executor.isModuleType(2)); // TYPE_EXECUTOR
        assertFalse(executor.isModuleType(1));
        assertFalse(executor.isModuleType(3));
    }

    function test_installAndExecute() public {
        uint256 maxPerCall = 50 * 1e6;
        uint256 maxTotal = 200 * 1e6;

        bytes memory installData = abi.encode(address(usdc), maxPerCall, maxTotal);
        account.installExecutor(address(executor), installData);

        assertTrue(executor.isInitialized(address(account)));

        // Execute 30 USDC transfer
        bytes[] memory results = executor.executeAutoPay(address(account), merchant, 30 * 1e6);
        assertEq(results.length, 1);
        assertEq(usdc.balanceOf(merchant), 30 * 1e6);
        assertEq(usdc.balanceOf(address(account)), 970 * 1e6);

        // Execute another 20 USDC
        executor.executeAutoPay(address(account), merchant, 20 * 1e6);
        assertEq(usdc.balanceOf(merchant), 50 * 1e6);
    }

    function test_revert_exceedsMaxPerCall() public {
        uint256 maxPerCall = 50 * 1e6;
        uint256 maxTotal = 200 * 1e6;

        bytes memory installData = abi.encode(address(usdc), maxPerCall, maxTotal);
        account.installExecutor(address(executor), installData);

        vm.expectRevert(
            abi.encodeWithSelector(
                Autopay7579Executor.ExceedsMaxPerCall.selector,
                60 * 1e6,
                50 * 1e6
            )
        );
        executor.executeAutoPay(address(account), merchant, 60 * 1e6);
    }

    function test_revert_exceedsMaxTotal() public {
        uint256 maxPerCall = 50 * 1e6;
        uint256 maxTotal = 70 * 1e6;

        bytes memory installData = abi.encode(address(usdc), maxPerCall, maxTotal);
        account.installExecutor(address(executor), installData);

        executor.executeAutoPay(address(account), merchant, 50 * 1e6);

        vm.expectRevert(
            abi.encodeWithSelector(
                Autopay7579Executor.ExceedsMaxTotal.selector,
                80 * 1e6,
                70 * 1e6
            )
        );
        executor.executeAutoPay(address(account), merchant, 30 * 1e6);
    }
}
