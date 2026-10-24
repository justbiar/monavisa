// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployMonaVisa} from "../script/DeployMonaVisa.s.sol";
import {AutopayModule} from "../src/AutopayModule.sol";
import {FeeCollector} from "../src/FeeCollector.sol";
import {PlanFactory} from "../src/PlanFactory.sol";
import {SessionVault} from "../src/SessionVault.sol";
import {SubscriptionRegistry} from "../src/SubscriptionRegistry.sol";
import {IAllowanceTransfer} from "../src/interfaces/IAllowanceTransfer.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Deploys the full Faz 1 stack through the real deploy script, against mock USDC and Permit2.
abstract contract MonaVisaBase is Test {
    uint96 internal constant PRICE = 49e6; // 49 USDC
    uint32 internal constant PERIOD = 30 days;
    uint32 internal constant GRACE = 3 days;
    uint16 internal constant FEE_BPS = 100; // 1%
    uint256 internal constant FEE = 49e4; // 0.49 USDC

    address internal admin = makeAddr("admin");
    address internal protocolTreasury = makeAddr("protocolTreasury");
    address internal merchant = makeAddr("merchant");
    address internal merchantTreasury = makeAddr("merchantTreasury");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");

    MockUSDC internal usdc;
    MockPermit2 internal permit2;
    FeeCollector internal fees;
    PlanFactory internal plans;
    SubscriptionRegistry internal registry;
    AutopayModule internal autopay;
    SessionVault internal vault;

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC();
        permit2 = new MockPermit2();

        DeployMonaVisa script = new DeployMonaVisa();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        DeployMonaVisa.Deployment memory d = script.deployWith(
            address(script),
            admin,
            protocolTreasury,
            FEE_BPS,
            FEE_BPS,
            tokens,
            IAllowanceTransfer(address(permit2))
        );
        fees = d.feeCollector;
        plans = d.planFactory;
        registry = d.registry;
        autopay = d.autopay;
        vault = d.sessionVault;

        _fundAndApprove(alice, 1000e6);
    }

    function _createPlan(uint32 trial) internal returns (uint256 planId) {
        vm.prank(merchant);
        planId = plans.createPlan(address(usdc), PRICE, PERIOD, trial, GRACE, merchantTreasury);
    }

    function _fundAndApprove(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(permit2), type(uint256).max);
        permit2.approve(address(usdc), address(autopay), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _subscribe(address who, uint256 planId) internal returns (uint256 subId) {
        vm.prank(who);
        subId = autopay.subscribe(planId);
    }

    /// @dev The module must never hold funds between calls.
    function _assertModuleEmpty() internal view {
        assertEq(usdc.balanceOf(address(autopay)), 0, "module holds funds");
    }
}
